import { describe, beforeEach, test } from '@jest/globals'
import path from 'node:path'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import { FileSystemObjectCache } from './fileSystemObjectCache'

const testDir = path.join(__dirname, '..', '.cache')

describe('FileSystemObjectCache', () => {
  beforeEach(async () => {
    if (await fs.stat(testDir).catch(() => false)) {
      await fs.rm(testDir, { force: true, recursive: true })
    }
  })

  test('Creates the directory when instantiated', async () => {
    new FileSystemObjectCache(testDir, true)
    expect(await fs.stat(testDir).catch(() => false)).toBeTruthy()
  })

  test('Puts an object in cache as json', async () => {
    const cache = new FileSystemObjectCache(testDir, true)

    await cache.put('test', { test: 1 })

    const data = await fs.readFile(path.join(testDir, 'test.json'), { encoding: 'utf-8' })
    expect(data).toMatchInlineSnapshot(`
      "{
        "test": 1
      }"
    `)
  })

  test('Clear json file cache', async () => {
    const cache = new FileSystemObjectCache(testDir, true)

    await cache.put('test', { test: 1 })

    const data = await fs.readFile(path.join(testDir, 'test.json'), { encoding: 'utf-8' })
    expect(data).toMatchInlineSnapshot(`
      "{
        "test": 1
      }"
    `)

    await cache.clearCache('test')
    const fileExist = fsSync.existsSync(path.join(testDir, 'test.json'))
    expect(fileExist).toBe(false)
  })

  test('Clear binary cache', async () => {
    const cache = new FileSystemObjectCache(testDir, true)
    const fileData = Uint8Array.from(atob('test'), (c) => c.charCodeAt(0))

    await cache.put('test', fileData)

    const data = await fs.readFile(path.join(testDir, 'test'))
    expect(data.compare(fileData)).toBe(0)

    await cache.clearCache('test')
    const fileExist = fsSync.existsSync(path.join(testDir, 'test'))
    expect(fileExist).toBe(false)
  })

  test("Get an object from cache if it didn't exist", async () => {
    const cache = new FileSystemObjectCache(testDir, true)

    const cached = await cache.getAndCache<{ test: number }>('test', async (_) => ({
      test: 1,
    }))

    expect(cached.test).toBe(1)
  })

  test('Get an object from cache if it did exist', async () => {
    const cache = new FileSystemObjectCache(testDir, true)
    await cache.put('test', { test: 1 })

    const cached = await cache.getAndCache<{ test: number }>('test', async (_) => ({
      test: 2,
    }))

    expect(cached.test).toBe(1)
  })

  test('Get an object from cache if it is not yet stale', async () => {
    const cache = new FileSystemObjectCache(testDir, true)
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
    const cache = new FileSystemObjectCache(testDir, true)
    await cache.put('test', { test: 1 })
    await new Promise((resolve) => setTimeout(resolve, 100))

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
    const cache = new FileSystemObjectCache(testDir, true)
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

  test('Throw an error if it is stale and there is an error refreshing', async () => {
    const cache = new FileSystemObjectCache(testDir, true)
    await cache.put('test', { test: 1 })
    await new Promise((resolve) => setTimeout(resolve, 100))

    await expect(() =>
      cache.getAndCache<{ test: number }>(
        'test',
        async (_) => {
          throw new Error('_ERROR_')
        },
        {
          staleAfterSeconds: 0,
        },
      ),
    ).rejects.toThrow('_ERROR_')
  })
})
