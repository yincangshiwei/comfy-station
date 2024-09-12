import { z } from 'zod'
import { zfd } from 'zod-form-data'
import { privateProcedure } from '../procedure'
import { router } from '../trpc'
import { Attachment } from '@/entities/attachment'
import AttachmentService from '@/services/attachment'
import { EAttachmentStatus } from '@/entities/enum'
import { ImageUtil } from '../utils/ImageUtil'
import { ECompressPreset } from '@/hooks/useAttachmentUploader'

export const attachmentRouter = router({
  get: privateProcedure
    .input(
      z.object({
        id: z.string()
      })
    )
    .query(async ({ ctx, input }) => {
      const attachment = await ctx.em.findOne(Attachment, { id: input.id })
      if (!attachment) {
        return null
      }
      return AttachmentService.getInstance().getFileURL(attachment.fileName)
    }),
  upload: privateProcedure
    .input(
      zfd.formData({
        file: zfd.file(),
        name: z.string(),
        /**
         * The maximum width and height of the image
         */
        maxWidthHeightSize: z
          .string()
          .transform((v) => Number(v))
          .optional(),
        /**
         * The type of compress image
         */
        type: z.nativeEnum(ECompressPreset).optional()
      })
    )
    .mutation(async ({ input, ctx }) => {
      const storageService = AttachmentService.getInstance()
      const file = input.file
      const buffArr = await file.arrayBuffer()
      let buff = Buffer.from(buffArr)
      const imgObj = new ImageUtil(buff)
      if (input.maxWidthHeightSize) {
        await imgObj.ensureMax(input.maxWidthHeightSize)
      }
      if (input.type) {
        switch (input.type) {
          case ECompressPreset.PREVIEW:
            buff = await imgObj.intoPreviewJPG()
            break
          case ECompressPreset.HIGH_JPG:
            buff = await imgObj.intoHighJPG()
            break
          case ECompressPreset.JPG:
            buff = await imgObj.intoJPG()
            break
        }
      }
      /**
       * Avoid uploading the same file multiple times
       */
      const fileMd5 = await Attachment.fileMD5(buff)
      const fileExtendsion = input.file.name.split('.').pop()
      const newName = `${fileMd5}.${fileExtendsion}`
      const size = buff.byteLength

      const existingAttachment = await ctx.em.findOne(Attachment, { fileName: newName })
      if (existingAttachment) {
        if (existingAttachment.status === EAttachmentStatus.UPLOADED) {
          return existingAttachment
        } else {
          await ctx.em.removeAndFlush(existingAttachment)
        }
      }
      const attachment = ctx.em.create(Attachment, { fileName: newName, size }, { partial: true })
      await ctx.em.persistAndFlush(attachment)
      try {
        await storageService.uploadFile(buff, newName)
        attachment.status = EAttachmentStatus.UPLOADED
        await ctx.em.persistAndFlush(attachment)
        return attachment
      } catch (e) {
        attachment.status = EAttachmentStatus.FAILED
        await ctx.em.persistAndFlush(attachment)
        return attachment
      }
    })
})
