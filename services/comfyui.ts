import { ComfyApi, ComfyPool } from '@saintno/comfyui-sdk'
import { Logger } from '@saintno/needed-tools'
import { MikroORMInstance } from './mikro-orm'
import { Client } from '@/entities/client'
import { EAuthMode, EClientStatus } from '@/entities/enum'
import { ClientStatusEvent } from '@/entities/client_status_event'
import { ClientMonitorEvent } from '@/entities/client_monitor_event'
import { ClientMonitorGpu } from '@/entities/client_monitor_gpu'

export class ComfyPoolInstance {
  public pool: ComfyPool
  private logger: Logger

  private lock = {
    monitoring: false
  }

  static getInstance() {
    if (!(global as any).__ComfyPool__) {
      ;(global as any).__ComfyPool__ = new ComfyPoolInstance()
    }
    return (global as any).__ComfyPool__ as ComfyPoolInstance
  }

  private constructor() {
    this.logger = new Logger('ComfyPoolInstance')
    this.pool = new ComfyPool([])
    this.bindEvents()
    this.initialize()
  }

  private async initialize() {
    const em = await MikroORMInstance.getInstance().getEM()
    const clients = await em.find(Client, {}, { populate: ['password'] })

    clients.forEach((clientConf) => {
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
    })
  }

  private bindEvents() {
    this.pool
      .on('init', () => this.logger.i('init', 'ComfyPool initialized'))
      .on('added', (ev) => {
        this.logger.i('added', `Add new client ${ev.detail.clientIdx}`, {
          id: ev.detail.client.id
        })
      })
      .on('have_job', async (ev) => {
        const em = await MikroORMInstance.getInstance().getEM()
        const client = await em.findOne(Client, { id: ev.detail.client.id })
        if (client) {
          const statusEvent = new ClientStatusEvent(client, EClientStatus.Executing)
          client.statusEvents.add(statusEvent)
          await em.persist(statusEvent).flush()
        }
      })
      .on('idle', async (ev) => {
        const em = await MikroORMInstance.getInstance().getEM()
        const client = await em.findOne(Client, { id: ev.detail.client.id })
        if (client) {
          const statusEvent = new ClientStatusEvent(client, EClientStatus.Online)
          client.statusEvents.add(statusEvent)
          await em.persist(statusEvent).flush()
        }
      })
      .on('connected', async (ev) => {
        this.logger.i('connected', `Client ${ev.detail.clientIdx} connected`, {
          id: ev.detail.client.id
        })
        const em = await MikroORMInstance.getInstance().getEM()
        const client = await em.findOne(Client, { id: ev.detail.client.id })
        if (client) {
          const statusEvent = new ClientStatusEvent(client, EClientStatus.Online)
          client.statusEvents.add(statusEvent)
          await em.persist(statusEvent).flush()
        }
      })
      .on('executing', async (ev) => {
        this.logger.i('executing', `Client ${ev.detail.clientIdx} executing`, {
          id: ev.detail.client.id
        })
        const em = await MikroORMInstance.getInstance().getEM()
        const client = await em.findOne(Client, { id: ev.detail.client.id })
        if (client) {
          const statusEvent = new ClientStatusEvent(client, EClientStatus.Executing)
          client.statusEvents.add(statusEvent)
          await em.persist(statusEvent).flush()
        }
      })
      .on('executed', async (ev) => {
        this.logger.i('executed', `Client ${ev.detail.clientIdx} executed`, {
          id: ev.detail.client.id
        })
        const em = await MikroORMInstance.getInstance().getEM()
        const client = await em.findOne(Client, { id: ev.detail.client.id })
        if (client) {
          const statusEvent = new ClientStatusEvent(client, EClientStatus.Online)
          client.statusEvents.add(statusEvent)
          await em.persist(statusEvent).flush()
        }
      })
      .on('auth_error', async (ev) => {
        const em = await MikroORMInstance.getInstance().getEM()
        const client = await em.findOne(Client, { id: ev.detail.client.id })

        if (client) {
          const statusEvent = new ClientStatusEvent(client, EClientStatus.Error)
          statusEvent.message = 'Authentication error'
          client.statusEvents.add(statusEvent)
          await em.persist(statusEvent).flush()
        }
      })
      .on('system_monitor', async (ev) => {
        if (this.lock.monitoring) {
          return
        } else {
          this.lock.monitoring = true
          setTimeout(() => {
            this.lock.monitoring = false
          }, 5000)
        }
        if (ev.detail.type === 'websocket') {
          const data = ev.detail.data
          const clientId = ev.detail.client.id
          const em = await MikroORMInstance.getInstance().getEM()
          const client = await em.findOne(Client, { id: clientId })
          if (client) {
            const gpus: ClientMonitorGpu[] = []
            const monitorEv = new ClientMonitorEvent(client)
            monitorEv.cpuUsage = data.cpu_utilization
            monitorEv.memoryUsage = data.ram_used / 1024
            monitorEv.memoryTotal = Math.round((data.ram_used / 1024 / data.ram_used_percent) * 100)
            data.gpus.forEach((gpu, idx) => {
              const gpuEv = new ClientMonitorGpu(
                monitorEv,
                idx,
                Math.round(gpu.vram_used / 1024),
                Math.round(gpu.vram_total)
              )
              gpuEv.temperature = gpu.gpu_temperature
              gpuEv.utlization = gpu.gpu_utilization
              gpus.push(gpuEv)
            })
            monitorEv.gpu.add(gpus)
            client.monitorEvents.add(monitorEv)
            await em.persist(monitorEv).flush()
          }
        }
      })
      .on('execution_error', (error) => {})
  }
}
