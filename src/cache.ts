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

/** Binary data along with its mime type and file extension */
export interface BinaryWithMetadata {
  /** Binary data */
  data: Uint8Array
  /** Mime type */
  mimeType: string
  /** File extension */
  fileExtension: string | null
}

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

  /**
   * Clear the cache value for te given cache key
   * @param cacheKey A unique key that identifies the cached value
   */
  clearCache(cacheKey: string): void
}
