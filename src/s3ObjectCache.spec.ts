import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { describe, test } from '@jest/globals'
import { S3ObjectCache } from './s3ObjectCache'

const maybe = process.env.BUCKET_NAME && process.env.AWS_REGION && process.env.ACCESS_KEY && process.env.SECRET ? describe : describe.skip

// eslint-disable-next-line @typescript-eslint/no-var-requires
const zlib = require('zlib')

maybe('S3ObjectCache', () => {
  const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.ACCESS_KEY!,
      secretAccessKey: process.env.SECRET!,
    },
  })
  const bucketName = process.env.BUCKET_NAME

  const checkFileExist = async (key: string) => {
    const bucketAndKey = {
      Bucket: bucketName,
      Key: key,
    }

    const fileExist = await s3Client
      .send(new HeadObjectCommand(bucketAndKey))
      .then(() => true)
      .catch(() => false)

    return fileExist
  }

  test('Puts an object in cache as json', async () => {
    const cache = new S3ObjectCache(s3Client, bucketName!)
    await cache.put('test', { test: 1 })

    const bucketAndKey = {
      Bucket: bucketName,
      Key: 'test.json.gz',
    }

    const data = await s3Client
      .send(new GetObjectCommand(bucketAndKey))
      .then(async (x) => ({ Body: await x.Body!.transformToByteArray(), LastModified: x.LastModified, ContentType: x.ContentType }))
      .catch(() => undefined)

    const json = data ? zlib.gunzipSync(data.Body!).toString('utf-8') : undefined
    expect(json).toMatchInlineSnapshot(`
      "{
        "test": 1
      }"
    `)
  })

  test('Clear json file cache', async () => {
    const cache = new S3ObjectCache(s3Client, bucketName!)
    const key = 'test.json.gz'

    await cache.put('test', { test: 1 })
    let fileExist = await checkFileExist(key)
    expect(fileExist).toBe(true)

    await cache.clearCache('test')
    fileExist = await checkFileExist(key)
    expect(fileExist).toBe(false)
  })

  test('Clear binary cache', async () => {
    const cache = new S3ObjectCache(s3Client, bucketName!)
    const fileData = Uint8Array.from(atob('test'), (c) => c.charCodeAt(0))
    const key = 'test.gz'

    await cache.put('test', fileData)
    let fileExist = await checkFileExist(key)
    expect(fileExist).toBe(true)

    await cache.clearCache('test')
    fileExist = await checkFileExist(key)
    expect(fileExist).toBe(false)
  })

  test("Get an object from cache if it didn't exist", async () => {
    const cache = new S3ObjectCache(s3Client, bucketName!)

    const cached = await cache.getAndCache<{ test: number }>('test', async (_) => ({
      test: 1,
    }))

    expect(cached.test).toBe(1)
  })

  test('Get an object from cache if it did exist', async () => {
    const cache = new S3ObjectCache(s3Client, bucketName!)
    await cache.put('test', { test: 1 })

    const cached = await cache.getAndCache<{ test: number }>('test', async (_) => ({
      test: 2,
    }))

    expect(cached.test).toBe(1)
  })

  test('Get an object from cache if it is not yet stale', async () => {
    const cache = new S3ObjectCache(s3Client, bucketName!)
    await cache.put('test', { test: 1 })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const cached = await cache.getAndCache<{ test: number }>(
      'test',
      async (_) => ({
        test: 2,
      }),
      { staleAfterSeconds: 2 },
    )

    expect(cached.test).toBe(1)
  })

  test('Get a fresh object if it is stale', async () => {
    const cache = new S3ObjectCache(s3Client, bucketName!)
    await cache.put('test', { test: 1 })
    await new Promise((resolve) => setTimeout(resolve, 1000))

    const cached = await cache.getAndCache<{ test: number }>(
      'test',
      async (_) => ({
        test: 2,
      }),
      { staleAfterSeconds: 0 },
    )

    expect(cached.test).toBe(2)
  })

  test('Get an object from cache if it is stale but there is an error and returnStaleOnError is set', async () => {
    const cache = new S3ObjectCache(s3Client, bucketName!)
    await cache.put('test', { test: 1 })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const cached = await cache.getAndCache<{ test: number }>(
      'test',
      async (_) => {
        throw new Error('error')
      },
      {
        staleAfterSeconds: 0,
        returnStaleResultOnError: true,
      },
    )

    expect(cached.test).toBe(1)
  })
})
