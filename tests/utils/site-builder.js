const os = require('os')
const path = require('path')
const process = require('process')

const tempDirectory = require('temp-dir')
const { toToml } = require('tomlify-j0.4')
const { v4: uuidv4 } = require('uuid')

const fs = require('../../src/lib/fs')

const ensureDir = (file) => {
  return fs.mkdirRecursiveAsync(file)
}

const createSiteBuilder = ({ siteName }) => {
  const directory = path.join(
    tempDirectory,
    `netlify-cli-tests-${process.version}`,
    `${process.pid}`,
    uuidv4(),
    siteName,
  )
  const tasks = [() => ensureDir(directory)]

  const builder = {
    directory,
    siteName,
    withNetlifyToml: ({ config, pathPrefix = '' }) => {
      const dest = path.join(directory, pathPrefix, 'netlify.toml')
      const content = toToml(config, {
        replace: (_, val) => {
          // Strip off `.0` from integers that tomlify normally generates

          if (!Number.isInteger(val)) {
            // Output normal value
            return false
          }

          return String(Math.round(val))
        },
        space: 2,
      })
      tasks.push(async () => {
        await ensureDir(path.dirname(dest))
        await fs.writeFileAsync(dest, content)
      })
      return builder
    },
    withPackageJson: ({ object, pathPrefix = '' }) => {
      const dest = path.join(directory, pathPrefix, 'package.json')
      tasks.push(async () => {
        const content = JSON.stringify(object, null, 2)
        await ensureDir(path.dirname(dest))
        await fs.writeFileAsync(dest, `${content}\n`)
      })
      return builder
    },
    withFunction: ({ pathPrefix = 'functions', path: filePath, handler }) => {
      const dest = path.join(directory, pathPrefix, filePath)
      tasks.push(async () => {
        await ensureDir(path.dirname(dest))
        await fs.writeFileAsync(dest, `exports.handler = ${handler.toString()}`)
      })
      return builder
    },
    withEdgeHandlers: ({ name = 'index.js', handlers }) => {
      const dest = path.join(directory, 'edge-handlers', path.extname(name) === '.js' ? name : `${name}.js`)
      tasks.push(async () => {
        const content = Object.entries(handlers)
          .map(([event, handler]) => {
            return `export const ${event} = ${handler.toString()}`
          })
          .join(os.EOL)
        await ensureDir(path.dirname(dest))
        await fs.writeFileAsync(dest, content)
      })
      return builder
    },
    withRedirectsFile: ({ redirects = [], pathPrefix = '' }) => {
      const dest = path.join(directory, pathPrefix, '_redirects')
      tasks.push(async () => {
        const content = redirects.map(({ from, to, status }) => `${from}      ${to}       ${status}`).join(os.EOL)
        await ensureDir(path.dirname(dest))
        await fs.writeFileAsync(dest, content)
      })
      return builder
    },
    withHeadersFile: ({ headers = [], pathPrefix = '' }) => {
      const dest = path.join(directory, pathPrefix, '_headers')
      tasks.push(async () => {
        const content = headers
          .map(
            ({ path: headerPath, headers: headersValues }) =>
              `${headerPath}${os.EOL}${headersValues.map((header) => `  ${header}`).join(`${os.EOL}`)}`,
          )
          .join(os.EOL)
        await ensureDir(path.dirname(dest))
        await fs.writeFileAsync(dest, content)
      })
      return builder
    },
    withContentFile: ({ path: filePath, content }) => {
      const dest = path.join(directory, filePath)
      tasks.push(async () => {
        await ensureDir(path.dirname(dest))
        await fs.writeFileAsync(dest, content)
      })
      return builder
    },
    withContentFiles: (files) => {
      files.forEach(builder.withContentFile)
      return builder
    },
    withEnvFile: ({ path: filePath = '.env', pathPrefix = '', env = {} }) => {
      const dest = path.join(directory, pathPrefix, filePath)
      tasks.push(async () => {
        await ensureDir(path.dirname(dest))
        await fs.writeFileAsync(
          dest,
          Object.entries(env)
            .map(([key, value]) => `${key}=${value}`)
            .join(os.EOL),
        )
      })
      return builder
    },
    buildAsync: async () => {
      for (const task of tasks) {
        // eslint-disable-next-line no-await-in-loop
        await task()
      }
      return builder
    },
    cleanupAsync: async () => {
      await fs.rmdirRecursiveAsync(directory).catch((error) => {
        console.warn(error)
      })
      return builder
    },
  }

  return builder
}

const withSiteBuilder = async (siteName, testHandler, skipCleanup) => {
  let builder
  try {
    builder = createSiteBuilder({ siteName })
    return await testHandler(builder)
  } finally {
    if (!skipCleanup) {
      await builder.cleanupAsync()
    }
  }
}

module.exports = { withSiteBuilder, createSiteBuilder }
