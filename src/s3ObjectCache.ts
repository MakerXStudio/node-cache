import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { BinaryCacheOptions, BinaryWithMetadata, CacheOptions, ObjectCache } from './cache'
import * as path from 'node:path'

import mime from 'mime'

/** Caches object/file data using AWS S3. */
export class S3ObjectCache implements ObjectCache {
  private s3Client: S3Client
  private bucket: string
  private keyPrefix?: string

  /**
   * Create an `S3ObjectCache`
   * @param s3Client An S3 client
   * @param bucket The name of the bucket to cache in
   * @param keyPrefix Optional prefix key to use for all cache entries; allows multiple caches to reside on a single S3 Bucket
   */
  constructor(s3Client: S3Client, bucket: string, keyPrefix?: string) {
    this.s3Client = s3Client
    this.bucket = bucket
    this.keyPrefix = keyPrefix
  }

  /**
   * Clear the cache value for te given cache key
   * @param cacheKey A unique key that identifies the cached value
   */
  async clearCache(cacheKey: string): Promise<void> {
    const deleteFile = async (key: string) => {
      const bucketAndKey = {
        Bucket: this.bucket,
        Key: key,
      }

      const fileExist = await this.s3Client
        .send(new HeadObjectCommand(bucketAndKey))
        .then(() => true)
        .catch(() => false)

      if (fileExist) {
        await this.s3Client.send(
          new DeleteObjectCommand({
            ...bucketAndKey,
          }),
        )
      }
    }

    deleteFile(this.keyPrefix ? path.join(this.keyPrefix, `${cacheKey}.gz`) : `${cacheKey}.gz`)
    deleteFile(this.keyPrefix ? path.join(this.keyPrefix, `${cacheKey}.json.gz`) : `${cacheKey}.json.gz`)
  }

  /** Adds the given value to the cache for the given cache key
   * @param cacheKey A unique key that identifies the cached value
   * @param data The data to cache
   * @param mimeType Optional mime type of the data; default = `application/json` or `application/octet-stream` depending on if the data is binary or JSON.
   */
  async put<T>(cacheKey: string, data: T, mimeType?: string): Promise<void> {
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
        ContentType: mimeType ?? (data instanceof Uint8Array ? 'application/octet-stream' : 'application/json'),
        Body: zlib.gzipSync(data instanceof Uint8Array ? data : JSON.stringify(data, null, 2)),
      }),
    )
  }

  /** Gets the cached value for the given cache key if it exists and
   * isn't expired, but otherwise gets the generated value while storing it in the cache
   * @param cacheKey A unique key that identifies the cached value
   * @param generator The async lambda that generates a "fresh" value when there is a cache miss
   * @param options Options to control the cache semantics
   **/
  async getAndCache<T>(cacheKey: string, generator: (existing: T | undefined) => Promise<T>, options?: CacheOptions): Promise<T> {
    const { staleAfterSeconds, returnStaleResultOnError, isBinary, mimeType: mT, _returnBinaryMetadata } = options ?? {}
    let mimeType = mT
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zlib = require('zlib')
    const fileName = isBinary ? `${cacheKey}.gz` : `${cacheKey}.json.gz`
    const bucketAndKey = {
      Bucket: this.bucket,
      Key: this.keyPrefix ? path.join(this.keyPrefix, fileName) : fileName,
    }
    const existingCache = await this.s3Client
      .send(new GetObjectCommand(bucketAndKey))
      .then(async (x) => ({ Body: await x.Body!.transformToByteArray(), LastModified: x.LastModified, ContentType: x.ContentType }))
      .catch(() => undefined)
    const expired =
      staleAfterSeconds !== undefined && existingCache && (+new Date() - +existingCache.LastModified!) / 1000 > staleAfterSeconds

    if (mimeType === undefined) {
      mimeType = existingCache?.ContentType ?? 'application/octet-stream'
    }
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
        await this.put(cacheKey, value, mimeType)
        // eslint-disable-next-line no-console
        console.log(`Cached value '${bucketAndKey.Key}' written`)
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e))
        if (existingCache && returnStaleResultOnError) {
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

    if (isBinary && _returnBinaryMetadata) {
      return {
        data: value! as unknown as Uint8Array,
        fileExtension: mime.getExtension(mimeType),
        mimeType,
      } as BinaryWithMetadata as unknown as T
    }

    return value!
  }

  /** Gets the cached value for the given cache key if it exists and
   * isn't expired, but otherwise gets the generated value while storing it in the cache;
   * expects binary data and returns the mime type as well as the data */
  async getAndCacheBinary(
    cacheKey: string,
    generator: (existing: Uint8Array | undefined) => Promise<Uint8Array>,
    options?: BinaryCacheOptions,
  ): Promise<BinaryWithMetadata> {
    options = options ?? {}
    return (await this.getAndCache<Uint8Array>(cacheKey, generator, {
      ...options,
      isBinary: true,
      _returnBinaryMetadata: true,
    })) as unknown as BinaryWithMetadata
  }

  /** Adds the given binary value to the cache for the given cache key
   * @param cacheKey A unique key that identifies the cached value
   * @param data The binary data to cache
   * @param mimeType Optional mime type of the data; default = `application/json` or `application/octet-stream` depending on if the data is binary or JSON.
   */
  putBinary(cacheKey: string, data: Uint8Array, mimeType?: string): Promise<void> {
    return this.putBinary(cacheKey, data, mimeType)
  }
}
