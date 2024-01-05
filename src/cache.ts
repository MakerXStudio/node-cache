import type { S3Client } from '@aws-sdk/client-s3'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import mime from 'mime'
import { glob } from 'glob'

/** Options to control cache semantics */
export interface CacheOptions {
  /** The number of seconds after caching upon which to consider the cached value as stale; default (undefined) = cache forever */
  staleAfterSeconds?: number
  /** Whether to return a stale cache result if there is an error getting a fresh value; adds resilience semantics, default = false */
  returnStaleResultOnError?: boolean
  /** Whether or not the value being cached is a binary value vs a JSON value; default = JSON */
  isBinary?: boolean
  /** Optional mime type of the data; default = `application/json` or `application/octet-stream` depending on `isBinary` */
  mimeType?: string
  /** [Internal use] Whether or not to return a `BinaryWithMetadata` object vs the raw binary (only valid if `isBinary` is specified); default = raw binary */
  _returnBinaryMetadata?: boolean
}

/** Options to control cache semantics for a binary cache value */
export type BinaryCacheOptions = Omit<CacheOptions, 'isBinary' | '_returnBinaryMetadata'>

/** Caches object/file data. */
export interface ObjectCache {
  /** Gets the cached value for the given cache key if it exists and
   * isn't expired, but otherwise gets the generated value while storing it in the cache
   * @param cacheKey A unique key that identifies the cached value
   * @param generator The async lambda that generates a "fresh" value when there is a cache miss
   * @param options Options to control the cache semantics
   **/
  getAndCache<T>(cacheKey: string, generator: (existing: T | undefined) => Promise<T>, options?: CacheOptions): Promise<T>

  /** Gets the cached value for the given cache key if it exists and
   * isn't expired, but otherwise gets the generated value while storing it in the cache;
   * expects binary data and returns the mime type as well as the data */
  getAndCacheBinary(
    cacheKey: string,
    generator: (existing: Uint8Array | undefined) => Promise<Uint8Array>,
    options?: BinaryCacheOptions,
  ): Promise<BinaryWithMetadata>

  /** Adds the given value to the cache for the given cache key
   * @param cacheKey A unique key that identifies the cached value
   * @param data The data to cache
   * @param mimeType Optional mime type of the data; default = `application/json` or `application/octet-stream` depending on if the data is binary or JSON.
   */
  put<T>(cacheKey: string, data: T, mimeType?: string): Promise<void>

  /** Adds the given binary value to the cache for the given cache key
   * @param cacheKey A unique key that identifies the cached value
   * @param data The binary data to cache
   * @param mimeType Optional mime type of the data; default = `application/json` or `application/octet-stream` depending on if the data is binary or JSON.
   */
  putBinary(cacheKey: string, data: Uint8Array, mimeType?: string): Promise<void>
}

/** Binary data along with its mime type and file extension */
export interface BinaryWithMetadata {
  /** Binary data */
  data: Uint8Array
  /** Mime type */
  mimeType: string
  /** File extension */
  fileExtension: string
}

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
    const expired = staleAfterSeconds && existingCache && (+new Date() - +existingCache.LastModified!) / 1000 > staleAfterSeconds

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
        data: value!,
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
    generator: (existing: Uint8Array) => Promise<Uint8Array>,
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

/** Caches object/file data using the filesystem; useful for running a cache during local development. */
export class FileSystemObjectCache implements ObjectCache {
  private cacheDirectory: string

  /**
   * Create a `FileSystemObjectCache`
   * @param cacheDirectory The file system directory to place cached files in
   * @param createDirectoryIfNotExists Whether to create the directory if it doesn't exist when this cache is instantiated; default = no
   */
  constructor(cacheDirectory: string, createDirectoryIfNotExists?: boolean) {
    this.cacheDirectory = cacheDirectory
    if (createDirectoryIfNotExists) {
      if (!fsSync.existsSync(cacheDirectory)) {
        fsSync.mkdirSync(cacheDirectory)
      }
    }
  }

  /** Adds the given value to the cache for the given cache key
   * @param cacheKey A unique key that identifies the cached value
   * @param data The data to cache
   * @param mimeType Optional mime type of the data; default = `application/json` or `application/octet-stream` depending on if the data is binary or JSON.
   */
  async put<T>(cacheKey: string, data: T): Promise<void> {
    const cachePath = path.join(this.cacheDirectory, data instanceof Uint8Array ? cacheKey : `${cacheKey}.json`)
    await fs.writeFile(cachePath, data instanceof Uint8Array ? data : JSON.stringify(data, null, 2), {
      encoding: data instanceof Uint8Array ? null : 'utf-8',
    })
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
    if (mimeType === undefined) {
      if (isBinary) {
        mimeType = 'application/octet-stream'
        const searchPattern = path.join(this.cacheDirectory, `${cacheKey}.*`)
        const files = await glob(searchPattern, { windowsPathsNoEscape: true })
        if (files.length > 0) {
          mimeType = mime.getType(files[0]) ?? 'application/octet-stream'
        }
      } else {
        mimeType = 'application/json'
      }
    }

    const cachePath = path.join(
      this.cacheDirectory,
      mimeType === 'application/octet-stream' ? cacheKey : `${cacheKey}.${mime.getExtension(mimeType)}`,
    )
    const existingCache = await fs.stat(cachePath).catch((_e) => false)
    const expired =
      staleAfterSeconds && typeof existingCache !== 'boolean' && (+new Date() - +existingCache.mtime) / 1000 > staleAfterSeconds

    if (!existingCache || expired) {
      // eslint-disable-next-line no-console
      console.debug(
        !existingCache
          ? `Cache value '${cacheKey}' empty; getting data for the first time`
          : `Cache value '${cacheKey}' expired: ${typeof existingCache !== 'boolean' && existingCache.mtime.toISOString()}`,
      )
      try {
        const existingValue = existingCache ? await fs.readFile(cachePath, { encoding: isBinary ? null : 'utf-8' }) : undefined
        const existing = existingValue
          ? isBinary
            ? (Buffer.from(existingValue) as unknown as T)
            : (JSON.parse(existingValue as string) as T)
          : undefined
        const value = await generator(existing)
        await this.put(cacheKey, value)
        // eslint-disable-next-line no-console
        console.log(`Cached value '${cacheKey}' written to ${cachePath}`)
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
      console.debug(`Found cached value '${cacheKey}' at ${cachePath} which is within ${staleAfterSeconds} seconds old so using that`)
    }

    if (isBinary) {
      const content = await fs.readFile(cachePath, { encoding: null })
      return (_returnBinaryMetadata
        ? ({
            data: Buffer.from(content),
            fileExtension: mime.getExtension(mimeType),
            mimeType,
          } as BinaryWithMetadata)
        : Buffer.from(content)) as unknown as T
    }

    const valueJson = await fs.readFile(cachePath, { encoding: 'utf-8' })
    const value = JSON.parse(valueJson) as T
    return value
  }

  /** Gets the cached value for the given cache key if it exists and
   * isn't expired, but otherwise gets the generated value while storing it in the cache;
   * expects binary data and returns the mime type as well as the data */
  async getAndCacheBinary(
    cacheKey: string,
    generator: (existing: Uint8Array) => Promise<Uint8Array>,
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
