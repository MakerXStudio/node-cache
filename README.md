# NodeJS Cache (node-cache)

> A NodeJS package that makes it easy to cache objects and files locally and in AWS

[![Build Status][build-img]][build-url]
[![Issues][issues-img]][issues-url]
[![Semantic Release][semantic-release-img]][semantic-release-url]

## Install

Ensure you are authenticated to the [GitHub package repository with your PAT](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-with-a-personal-access-token) and add an `.npmrc` with the below contents:

```
@makerxstudio:registry=https://npm.pkg.github.com
```

```bash
npm install @makerxstudio/node-cache
```

## Usage

The primary purpose of this package is to make it easy to cache objects and files.

```typescript
import { S3 } from '@aws-sdk/client-s3'
import { FileSystemObjectCache, S3ObjectCache } from '@makerxstudio/node-cache'

const cache =
  process.env.CACHE_BUCKET_NAME === 'local'
    ? new FileSystemObjectCache(path.join(__dirname, '../.cache'))
    : new S3ObjectCache(
        new S3({
          region: process.env.AWS_REGION,
        }),
        process.env.CACHE_BUCKET_NAME,
        'optional/cache/prefix',
      )

for (let i =0; i < 10; i++>) {
  const value = await cache.getAndCache('test', async (existing: {test: number} | undefined) => {
    await new Promise(resolve => setTimeout(resolve, 100))
    const e = existing ?? {test: 1}
    e.test++
    return e
  }, {
    staleAfterSeconds: 1
  })
  console.log(value)
  await new Promise(resolve => setTimeout(resolve, 500))
}

await cache.put('test', {test: 100})

```

---

[build-img]: https://github.com/MakerXStudio/node-cache/actions/workflows/release.yaml/badge.svg
[build-url]: https://github.com/MakerXStudio/node-cache/actions/workflows/release.yaml
[issues-img]: https://img.shields.io/github/issues/MakerXStudio/node-cache
[issues-url]: https://github.com/MakerXStudio/node-cache/issues
[semantic-release-img]: https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg
[semantic-release-url]: https://github.com/semantic-release/semantic-release
