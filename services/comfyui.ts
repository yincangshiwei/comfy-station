import { CallWrapper, ComfyApi, ComfyPool, EQueueMode, PromptBuilder, TMonitorEvent } from '@saintno/comfyui-sdk'
import { Logger } from '@saintno/needed-tools'
import { MikroORMInstance } from './mikro-orm'
import { Client } from '@/entities/client'
import { EAttachmentStatus, EAuthMode, EClientStatus, EStorageType, ETaskStatus, EValueType } from '@/entities/enum'
import { ClientStatusEvent } from '@/entities/client_status_event'
import { ClientMonitorEvent } from '@/entities/client_monitor_event'
import { ClientMonitorGpu } from '@/entities/client_monitor_gpu'
import CachingService from './caching'

import { cloneDeep, throttle, uniqueId } from 'lodash'
import { WorkflowTask } from '@/entities/workflow_task'
import { WorkflowTaskEvent } from '@/entities/workflow_task_event'
import { getBuilder, parseOutput } from '@/utils/workflow'
import { Attachment } from '@/entities/attachment'
import AttachmentService, { EAttachmentType } from './attachment'
import { ImageUtil } from '@/server/utils/ImageUtil'
import { delay } from '@/utils/tools'

const MONITOR_INTERVAL = 5000

export class ComfyPoolInstance {
  public pool: ComfyPool
  private cachingService: CachingService
  private logger: Logger

  static getInstance() {
    if (!(global as any).__ComfyPool__) {
      ;(global as any).__ComfyPool__ = new ComfyPoolInstance()
    }
    return (global as any).__ComfyPool__ as ComfyPoolInstance
  }

  private constructor() {
    this.cachingService = CachingService.getInstance()
    this.logger = new Logger('ComfyPoolInstance')
    this.pool = new ComfyPool([])
    this.bindEvents()
    this.initialize()
  }

  private async initialize() {
    const em = await MikroORMInstance.getInstance().getEM()
    const clients = await em.find(Client, {}, { populate: ['password'] })

    for (const clientConf of clients) {
      const client = new ComfyApi(clientConf.host, clientConf.id, {
        credentials:
          clientConf.auth === EAuthMode.Basic
            ? {
                type: 'basic',
                username: clientConf.username ?? '',
                password: clientConf.password ?? ''
              }
            : undefined
      })
      this.pool.addClient(client)
    }
    this.cleanAllRunningTasks().then(() => delay(1000).then(() => this.pickingJob()))
  }

  private addClientMonitoring = throttle(async (clientId: string, data: TMonitorEvent) => {
    const em = await MikroORMInstance.getInstance().getEM()
    const client = await em.findOne(Client, { id: clientId })

    if (client) {
      const gpus: ClientMonitorGpu[] = []
      const monitorEv = new ClientMonitorEvent(client)
      monitorEv.cpuUsage = data.cpu_utilization
      monitorEv.memoryUsage = data.ram_used / 1024
      monitorEv.memoryTotal = Math.round((data.ram_used / 1024 / data.ram_used_percent) * 100)
      data.gpus.forEach((gpu, idx) => {
        const gpuEv = new ClientMonitorGpu(monitorEv, idx, Math.round(gpu.vram_used / 1024), Math.round(gpu.vram_total))
        gpuEv.temperature = gpu.gpu_temperature
        gpuEv.utlization = gpu.gpu_utilization
        gpus.push(gpuEv)
      })
      monitorEv.gpus.add(gpus)
      client.monitorEvents.add(monitorEv)
      await em.persist(monitorEv).flush()
    }
  }, MONITOR_INTERVAL)

  updateTaskEventFn = async (
    task: WorkflowTask,
    status: ETaskStatus,
    extra?: {
      clientId?: string
      details?: string
      data?: any
    }
  ) => {
    const em = await MikroORMInstance.getInstance().getEM()
    const taskEvent = new WorkflowTaskEvent(task)
    taskEvent.status = status
    if (extra?.details) {
      taskEvent.details = extra.details
    }
    if (extra?.data) {
      taskEvent.data = extra.data
    }
    task.events.add(taskEvent)
    task.status = status
    await Promise.all([
      em.persist(taskEvent).flush(),
      this.cachingService.set('LAST_TASK_CLIENT', extra?.clientId || -1, Date.now()),
      this.cachingService.set('HISTORY_ITEM', task.id || -1, Date.now())
    ])
    if (task.parent?.id) {
      this.cachingService.set('HISTORY_ITEM', task.parent.id, Date.now())
    }
    if ([ETaskStatus.Failed, ETaskStatus.Success, ETaskStatus.Pending].includes(status)) {
      if (status === ETaskStatus.Success && extra?.details !== 'FINISHED') return
      await CachingService.getInstance().set('WORKFLOW', task.workflow.id, Date.now())
    }
  }

  private async cleanAllRunningTasks() {
    const em = await MikroORMInstance.getInstance().getEM()
    const processingTasks = await em.find(WorkflowTask, {
      status: {
        $in: [ETaskStatus.Pending, ETaskStatus.Running]
      }
    })
    for (const task of processingTasks) {
      task.status = ETaskStatus.Queuing
    }
    await em.flush()
  }

  private async pickingJob() {
    const pool = this.pool
    const em = await MikroORMInstance.getInstance().getEM()
    const queuingTasks = await em.find(
      WorkflowTask,
      { status: ETaskStatus.Queuing },
      { populate: ['workflow', 'parent'], orderBy: { createdAt: 'ASC' } }
    )
    if (queuingTasks.length > 0) {
      for (let i = 0; i < queuingTasks.length; i++) {
        const task = queuingTasks[i]
        await this.updateTaskEventFn(task, ETaskStatus.Pending)
        const workflow = task.workflow
        const input = task.inputValues
        const builder = getBuilder(workflow)
        pool.run(async (api) => {
          const client = await em.findOne(Client, { id: api.id })
          if (client) {
            task.client = client
            await em.persist(task).flush()
            await this.cachingService.set('LAST_TASK_CLIENT', api.id, Date.now())
          }
          for (const key in input) {
            const inputData = input[key] || workflow.mapInput?.[key].default
            if (!inputData) {
              continue
            }
            switch (workflow.mapInput?.[key].type) {
              case EValueType.Number:
              case EValueType.Seed:
                builder.input(key, Number(inputData))
                break
              case EValueType.String:
                builder.input(key, String(inputData))
                break
              case EValueType.File:
              case EValueType.Image:
                const attachmentId = inputData as string
                const file = await em.findOneOrFail(Attachment, { id: attachmentId })
                const fileBlob = await AttachmentService.getInstance().getFileBlob(file.fileName)
                if (!fileBlob) {
                  await this.updateTaskEventFn(task, ETaskStatus.Failed, {
                    details: `Can not load attachments ${file.fileName}`,
                    clientId: api.id
                  })
                  await this.cachingService.set('LAST_TASK_CLIENT', api.id, Date.now())
                  return
                }
                const uploadedImg = await api.uploadImage(fileBlob, file.fileName)
                if (!uploadedImg) {
                  await this.updateTaskEventFn(task, ETaskStatus.Failed, {
                    details: `Failed to upload attachment into comfy server, ${file.fileName}`,
                    clientId: api.id
                  })
                  await this.cachingService.set('LAST_TASK_CLIENT', api.id, Date.now())
                  return
                }
                builder.input(key, uploadedImg.info.filename)
                break
              default:
                builder.input(key, inputData)
                break
            }
          }
          return new CallWrapper(api, builder)
            .onPending(async () => {
              await this.updateTaskEventFn(task, ETaskStatus.Running, {
                details: 'LOADING RESOURCES',
                clientId: api.id
              })
            })
            .onProgress(async (e) => {
              await this.updateTaskEventFn(task, ETaskStatus.Running, {
                details: JSON.stringify({
                  key: 'progress',
                  data: { node: Number(e.node), max: Number(e.max), value: Number(e.value) }
                }),
                clientId: api.id
              })
            })
            .onPreview(async (e) => {
              const arrayBuffer = await e.arrayBuffer()
              const base64String = Buffer.from(arrayBuffer).toString('base64')
              await this.cachingService.set('PREVIEW', task.id, base64String)
            })
            .onStart(async () => {
              await this.updateTaskEventFn(task, ETaskStatus.Running, {
                details: 'START RENDERING',
                clientId: api.id
              })
            })
            .onFinished(async (outData) => {
              await this.updateTaskEventFn(task, ETaskStatus.Success, {
                details: 'DOWNLOADING OUTPUT',
                clientId: api.id
              })
              const attachment = AttachmentService.getInstance()
              const output = await parseOutput(api, workflow, outData)
              await this.updateTaskEventFn(task, ETaskStatus.Success, {
                details: 'UPLOADING OUTPUT',
                clientId: api.id
              })
              const tmpOutput = cloneDeep(output) as Record<string, any>
              // If key is array of Blob, convert it to base64
              for (const key in tmpOutput) {
                if (Array.isArray(tmpOutput[key])) {
                  tmpOutput[key] = (await Promise.all(
                    tmpOutput[key].map(async (v, idx) => {
                      if (v instanceof Blob) {
                        const imgUtil = new ImageUtil(Buffer.from(await v.arrayBuffer()))
                        const [preview, png] = await Promise.all([
                          (await imgUtil.clone())
                            .resizeMax(1024)
                            .intoPreviewJPG()
                            .catch((e) => {
                              this.logger.w('Error while converting to preview', e)
                              return null
                            }),
                          imgUtil.intoPNG()
                        ])
                        const tmpName = `${task.id}_${key}_${idx}.png`
                        const [uploaded] = await Promise.all([
                          attachment.uploadFile(png, `${tmpName}`),
                          preview ? attachment.uploadFile(preview, `${tmpName}_preview.jpg`) : Promise.resolve(false)
                        ])
                        if (uploaded) {
                          const fileInfo = await attachment.getFileURL(tmpName)
                          const ratio = await imgUtil.getRatio()
                          const outputAttachment = em.create(
                            Attachment,
                            {
                              fileName: tmpName,
                              size: png.byteLength,
                              storageType:
                                fileInfo?.type === EAttachmentType.LOCAL ? EStorageType.LOCAL : EStorageType.S3,
                              status: EAttachmentStatus.UPLOADED,
                              ratio,
                              task,
                              workflow
                            },
                            { partial: true }
                          )
                          em.persist(outputAttachment)
                          return outputAttachment.id
                        }
                      }
                      return v
                    })
                  )) as string[]
                }
              }
              const outputConfig = workflow.mapOutput
              const outputData = Object.keys(outputConfig || {}).reduce(
                (acc, val) => {
                  if (tmpOutput[val] && outputConfig?.[val]) {
                    acc[val] = {
                      type: outputConfig[val].type as EValueType,
                      value: tmpOutput[val] as any
                    }
                  }
                  return acc
                },
                {} as Record<
                  string,
                  {
                    type: EValueType
                    value: any
                  }
                >
              )
              await Promise.all([
                em.flush(),
                this.updateTaskEventFn(task, ETaskStatus.Success, {
                  details: 'FINISHED',
                  clientId: api.id,
                  data: outputData
                })
              ])
            })
            .onFailed(async (e) => {
              await this.updateTaskEventFn(task, ETaskStatus.Failed, {
                details: (e.cause as any)?.error?.message || e.message,
                clientId: api.id
              })
              console.error(e)
            })
            .run()
            .catch(async (e) => {
              await this.updateTaskEventFn(task, ETaskStatus.Failed, {
                details: (e.cause as any)?.error?.message || e.message,
                clientId: api.id
              })
              console.error(e)
              throw e
            })
        })
      }
      await this.cachingService.set('LAST_TASK_CLIENT', -1, Date.now())
      await em.flush()
    }
    delay(2000).then(() => this.pickingJob())
  }

  async setClientStatus(clientId: string, status: EClientStatus, msg?: string) {
    const em = await MikroORMInstance.getInstance().getEM()
    const client = await em.findOne(Client, { id: clientId })
    if (client) {
      const statusEvent = new ClientStatusEvent(client, status)
      if (msg) {
        statusEvent.message = msg
      }
      client.statusEvents.add(statusEvent)
      await this.cachingService.set('CLIENT_STATUS', client.id, status)
      await em.persist(statusEvent).flush()
    }
  }

  private bindEvents() {
    this.pool
      .on('init', async () => {
        this.logger.i('init', 'ComfyPool initialized')
        this.setClientStatus('all', EClientStatus.Offline)
      })
      .on('added', (ev) => {
        this.logger.i('added', `Add new client ${ev.detail.clientIdx}`, {
          id: ev.detail.client.id
        })
      })
      .on('connection_error', async (ev) => {
        this.logger.i('connection_error', 'Connection error', ev.detail.client.id)
        this.setClientStatus(ev.detail.client.id, EClientStatus.Error, 'Connection error')
      })
      .on('auth_error', async (ev) => {
        this.logger.i('auth_error', 'Authentication error', ev.detail.client.id)
        this.setClientStatus(ev.detail.client.id, EClientStatus.Error, 'Authentication error')
      })
      .on('have_job', async (ev) => {
        this.logger.i('have_job', 'Have job', ev.detail.client.id)
        this.setClientStatus(ev.detail.client.id, EClientStatus.Executing)
      })
      .on('idle', async (ev) => {
        this.logger.i('idle', 'Idle', ev.detail.client.id)
        this.setClientStatus(ev.detail.client.id, EClientStatus.Online)
      })
      .on('connected', async (ev) => {
        this.logger.i('connected', `Client ${ev.detail.clientIdx} connected`, {
          id: ev.detail.client.id
        })
        this.setClientStatus(ev.detail.client.id, EClientStatus.Online)
      })
      .on('reconnected', async (ev) => {
        this.logger.i('reconnected', `Client ${ev.detail.clientIdx} reconnected`, {
          id: ev.detail.client.id
        })
        this.setClientStatus(ev.detail.client.id, EClientStatus.Online, 'Reconnected')
      })
      .on('disconnected', async (ev) => {
        this.logger.i('disconnected', `Client ${ev.detail.clientIdx} disconnected`, {
          id: ev.detail.client.id
        })
        this.setClientStatus(ev.detail.client.id, EClientStatus.Offline)
      })
      .on('executing', async (ev) => {
        this.logger.i('executing', `Client ${ev.detail.clientIdx} executing`, {
          id: ev.detail.client.id
        })
        this.setClientStatus(ev.detail.client.id, EClientStatus.Executing)
      })
      .on('executed', async (ev) => {
        this.logger.i('executed', `Client ${ev.detail.clientIdx} executed`, {
          id: ev.detail.client.id
        })
        this.setClientStatus(ev.detail.client.id, EClientStatus.Online)
      })
      .on('system_monitor', async (ev) => {
        const data = ev.detail.data
        const clientId = ev.detail.client.id
        await this.cachingService.set('SYSTEM_MONITOR', clientId, data)
        this.addClientMonitoring(clientId, data)
      })
      .on('execution_error', (error) => {})
  }
}
