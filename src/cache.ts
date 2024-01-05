import type { S3Client } from '@aws-sdk/client-s3'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import fs from 'fs/promises'
import path from 'path'

export interface ObjectCache {
  getAndCache<T>(
    cacheKey: string,
    generator: (existing: T | undefined) => Promise<T>,
    staleAfterSeconds?: number,
    returnStaleResult?: boolean,
    isBinary?: boolean,
  ): Promise<T>

  put<T>(cacheKey: string, data: T): Promise<void>
}

export class S3ObjectCache implements ObjectCache {
  private s3Client: S3Client
  private bucket: string
  private keyPrefix?: string

  constructor(s3Client: S3Client, bucket: string, keyPrefix?: string) {
    this.s3Client = s3Client
    this.bucket = bucket
    this.keyPrefix = keyPrefix
  }

  async put<T>(cacheKey: string, data: T): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zlib = require('zlib')
    const fileName = data instanceof Uint8Array ? `${cacheKey}.gz` : `${cacheKey}.json.gz`
    const bucketAndKey = {
      Bucket: this.bucket,
      Key: this.keyPrefix ? path.join(this.keyPrefix, fileName) : fileName,
    }
    await this.s3Client.send(
      new PutObjectCommand({
        ...bucketAndKey,
        Body: zlib.gzipSync(data instanceof Uint8Array ? data : JSON.stringify(data, null, 2)),
      }),
    )
  }

  async getAndCache<T>(
    cacheKey: string,
    generator: (existing: T | undefined) => Promise<T>,
    staleAfterSeconds?: number,
    returnStaleResult?: boolean,
    isBinary?: boolean,
  ): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zlib = require('zlib')
    const fileName = isBinary ? `${cacheKey}.gz` : `${cacheKey}.json.gz`
    const bucketAndKey = {
      Bucket: this.bucket,
      Key: this.keyPrefix ? path.join(this.keyPrefix, fileName) : fileName,
    }
    const existingCache = await this.s3Client
      .send(new GetObjectCommand(bucketAndKey))
      .then(async (x) => ({ Body: await x.Body!.transformToByteArray(), LastModified: x.LastModified }))
      .catch(() => undefined)
    const expired = staleAfterSeconds && existingCache && (+new Date() - +existingCache.LastModified!) / 1000 > staleAfterSeconds

    const existingJson = !!existingCache && !isBinary ? zlib.gunzipSync(existingCache.Body!).toString('utf-8') : undefined
    const existing = existingCache ? (isBinary ? (zlib.gunzipSync(existingCache.Body!) as T) : (JSON.parse(existingJson) as T)) : undefined

    let value = existing
    if (!existing || expired) {
      // eslint-disable-next-line no-console
      console.debug(
        !existingCache
          ? `Cache value '${cacheKey}' empty; getting data for the first time`
          : `Cache value '${cacheKey}' expired: ${existingCache.LastModified!.toISOString()}`,
      )
      try {
        value = await generator(existing)
        await this.put(cacheKey, value)
        // eslint-disable-next-line no-console
        console.log(`Cached value '${bucketAndKey.Key}' written`)
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e))
        if (existingCache && returnStaleResult) {
          // eslint-disable-next-line no-console
          console.error(err)
          // eslint-disable-next-line no-console
          console.warn(
            `Received error ${
              err.message || err
            } when trying to repopulate cache value '${cacheKey}'; failing gracefully and using the cache`,
          )
        } else {
          throw e
        }
      }
    } else {
      // eslint-disable-next-line no-console
      console.debug(`Found cached value '${bucketAndKey.Key}' which is within ${staleAfterSeconds} seconds old so using that`)
    }

    return value!
  }
}

export class FileSystemObjectCache implements ObjectCache {
  private cacheDirectory: string
  constructor(cacheDirectory: string) {
    this.cacheDirectory = cacheDirectory
  }

  async put<T>(cacheKey: string, data: T): Promise<void> {
    const cachePath = path.join(this.cacheDirectory, data instanceof Uint8Array ? cacheKey : `${cacheKey}.json`)
    await fs.writeFile(cachePath, data instanceof Uint8Array ? data : JSON.stringify(data, null, 2), {
      encoding: data instanceof Uint8Array ? null : 'utf-8',
    })
  }

  async getAndCache<T>(
    cacheKey: string,
    generator: (existing: T | undefined) => Promise<T>,
    staleAfterSeconds?: number,
    returnStaleResult?: boolean,
    isBinary?: boolean,
  ): Promise<T> {
    const cachePath = path.join(this.cacheDirectory, isBinary ? cacheKey : `${cacheKey}.json`)
    const existingCache = await fs.stat(cachePath).catch((_e) => false)
    const expired =
      staleAfterSeconds && typeof existingCache !== 'boolean' && (+new Date() - +existingCache.mtime) / 1000 > staleAfterSeconds

    if (!existingCache || expired) {
      // eslint-disable-next-line no-console
      console.debug(
        !existingCache
          ? `Cache value '${cacheKey}' empty; getting data for the first time`
          : `Cache value '${cacheKey}' expired: ${existingCache.mtime.toISOString()}`,
      )
      try {
        const existingJson = existingCache ? await fs.readFile(cachePath, { encoding: isBinary ? null : 'utf-8' }) : undefined
        const existing = existingJson
          ? isBinary
            ? (Buffer.from(existingJson) as unknown as T)
            : (JSON.parse(existingJson as string) as T)
          : undefined
        const value = await generator(existing)
        await this.put(cacheKey, value)
        // eslint-disable-next-line no-console
        console.log(`Cached value '${cacheKey}' written to ${cachePath}`)
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e))
        if (existingCache && returnStaleResult) {
          // eslint-disable-next-line no-console
          console.error(err)
          // eslint-disable-next-line no-console
          console.warn(
            `Received error ${
              err.message || err
            } when trying to repopulate cache value '${cacheKey}'; failing gracefully and using the cache`,
          )
        } else {
          throw e
        }
      }
    } else {
      // eslint-disable-next-line no-console
      console.debug(`Found cached value '${cacheKey}' at ${cachePath} which is within ${staleAfterSeconds} seconds old so using that`)
    }

    if (isBinary) {
      const content = await fs.readFile(cachePath, { encoding: null })
      return Buffer.from(content) as unknown as T
    }

    const valueJson = await fs.readFile(cachePath, { encoding: 'utf-8' })
    const value = JSON.parse(valueJson) as T
    return value
  }
}
