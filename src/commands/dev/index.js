const childProcess = require('child_process')
const path = require('path')
const process = require('process')

const { flags: flagsLib } = require('@oclif/command')
const boxen = require('boxen')
const chalk = require('chalk')
const StaticServer = require('static-server')
const stripAnsiCc = require('strip-ansi-control-characters')
const waitPort = require('wait-port')
const which = require('which')
const wrapAnsi = require('wrap-ansi')

const Command = require('../../utils/command')
const { serverSettings } = require('../../utils/detect-server')
const { addEnvVariables } = require('../../utils/dev')
const { getEnvSettings } = require('../../utils/env')
const { startLiveTunnel } = require('../../utils/live-tunnel')
const { NETLIFYDEV, NETLIFYDEVLOG, NETLIFYDEVWARN, NETLIFYDEVERR } = require('../../utils/logo')
const openBrowser = require('../../utils/open-browser')
const { startProxy } = require('../../utils/proxy')
const { startFunctionsServer } = require('../../utils/serve-functions')
const { startForwardProxy } = require('../../utils/traffic-mesh')

const startFrameworkServer = async function ({ settings, log, exit }) {
  if (settings.noCmd) {
    const server = new StaticServer({
      rootPath: settings.dist,
      name: 'netlify-dev',
      port: settings.frameworkPort,
      templates: {
        notFound: path.join(settings.dist, '404.html'),
      },
    })

    await new Promise((resolve) => {
      server.start(function onListening() {
        log(`\n${NETLIFYDEVLOG} Server listening to`, settings.frameworkPort)
        resolve()
      })
    })
    return
  }

  log(`${NETLIFYDEVLOG} Starting Netlify Dev with ${settings.framework || 'custom config'}`)
  const commandBin = await which(settings.command).catch((error) => {
    if (error.code === 'ENOENT') {
      throw new Error(
        `"${settings.command}" could not be found in your PATH. Please make sure that "${settings.command}" is installed and available in your PATH`,
      )
    }
    throw error
  })
  const ps = childProcess.spawn(commandBin, settings.args, {
    env: { ...process.env, ...settings.env, FORCE_COLOR: 'true' },
    stdio: 'pipe',
  })

  ps.stdout.pipe(stripAnsiCc.stream()).pipe(process.stdout)
  ps.stderr.pipe(stripAnsiCc.stream()).pipe(process.stderr)

  process.stdin.pipe(process.stdin)

  const handleProcessExit = function (code) {
    log(
      code > 0 ? NETLIFYDEVERR : NETLIFYDEVWARN,
      `"${[settings.command, ...settings.args].join(' ')}" exited with code ${code}. Shutting down Netlify Dev server`,
    )
    process.exit(code)
  }
  ps.on('close', handleProcessExit)
  ps.on('SIGINT', handleProcessExit)
  ps.on('SIGTERM', handleProcessExit)
  ;['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGHUP', 'exit'].forEach((signal) => {
    process.on(signal, () => {
      try {
        process.kill(-ps.pid)
      } catch (error) {
        // Ignore
      }
      process.exit()
    })
  })

  try {
    const open = await waitPort({ port: settings.frameworkPort, output: 'silent', timeout: FRAMEWORK_PORT_TIMEOUT })
    if (!open) {
      throw new Error(`Timed out waiting for port '${settings.frameworkPort}' to be open`)
    }
  } catch (error) {
    log(NETLIFYDEVERR, `Netlify Dev could not connect to localhost:${settings.frameworkPort}.`)
    log(NETLIFYDEVERR, `Please make sure your framework server is running on port ${settings.frameworkPort}`)
    exit(1)
  }

  return ps
}

// 1 minute
const FRAMEWORK_PORT_TIMEOUT = 6e5

const getAddonsUrlsAndAddEnvVariablesToProcessEnv = async ({ api, site, flags }) => {
  if (site.id && !flags.offline) {
    const addonUrls = await addEnvVariables(api, site)
    return addonUrls
  }
  return {}
}

const addDotFileEnvs = async ({ site, log, warn }) => {
  // add .env file environment variables
  const envSettings = await getEnvSettings({ projectDir: site.root, warn })
  if (envSettings.vars.length !== 0) {
    log(
      `${NETLIFYDEVLOG} Adding the following env variables from ${envSettings.files.map((file) => chalk.blue(file))}:`,
      chalk.yellow(envSettings.vars.map(([key]) => key)),
    )
    envSettings.vars.forEach(([key, val]) => {
      process.env[key] = val
    })
  }
}

const startProxyServer = async ({ flags, settings, site, log, exit, addonUrls }) => {
  let url
  if (flags.trafficMesh) {
    url = await startForwardProxy({
      port: settings.port,
      frameworkPort: settings.frameworkPort,
      functionsPort: settings.functionsPort,
      publishDir: settings.dist,
      log,
      debug: flags.debug,
    })
    if (!url) {
      log(NETLIFYDEVERR, `Unable to start forward proxy on port '${settings.port}'`)
      exit(1)
    }
  } else {
    url = await startProxy(settings, addonUrls, site.configPath, site.root)
    if (!url) {
      log(NETLIFYDEVERR, `Unable to start proxy server on port '${settings.port}'`)
      exit(1)
    }
  }
  return url
}

const handleLiveTunnel = async ({ flags, site, api, settings, log }) => {
  if (flags.live) {
    const sessionUrl = await startLiveTunnel({
      siteId: site.id,
      netlifyApiToken: api.accessToken,
      localPort: settings.port,
      log,
    })
    process.env.BASE_URL = sessionUrl
    return sessionUrl
  }
}

const reportAnalytics = async ({ config, settings }) => {
  await config.runHook('analytics', {
    eventName: 'command',
    payload: {
      command: 'dev',
      projectType: settings.framework || 'custom',
      live: flagsLib.live || false,
    },
  })
}

const BANNER_LENGTH = 70

const printBanner = ({ url, log }) => {
  // boxen doesnt support text wrapping yet https://github.com/sindresorhus/boxen/issues/16
  const banner = wrapAnsi(chalk.bold(`${NETLIFYDEVLOG} Server now ready on ${url}`), BANNER_LENGTH)

  log(
    boxen(banner, {
      padding: 1,
      margin: 1,
      align: 'center',
      borderColor: '#00c7b7',
    }),
  )
}

class DevCommand extends Command {
  async run() {
    this.log(`${NETLIFYDEV}`)
    const { error: errorExit, log, warn, exit } = this
    const { flags } = this.parse(DevCommand)
    const { api, site, config } = this.netlify
    config.dev = { ...config.dev }
    config.build = { ...config.build }
    const devConfig = {
      framework: '#auto',
      ...(config.build.functions && { functions: config.build.functions }),
      ...(config.build.publish && { publish: config.build.publish }),
      ...config.dev,
      ...flags,
    }

    const addonUrls = await getAddonsUrlsAndAddEnvVariablesToProcessEnv({ api, site, flags })
    process.env.NETLIFY_DEV = 'true'
    await addDotFileEnvs({ site, log, warn })

    let settings = {}
    try {
      settings = await serverSettings(devConfig, flags, site.root, log)
    } catch (error) {
      log(NETLIFYDEVERR, error.message)
      exit(1)
    }

    await startFunctionsServer({ settings, site, log, warn, errorExit, siteInfo: this.netlify.cachedConfig.siteInfo })
    await startFrameworkServer({ settings, log, exit })

    let url = await startProxyServer({ flags, settings, site, log, exit, addonUrls })

    const liveTunnelUrl = await handleLiveTunnel({ flags, site, api, settings, log })
    url = liveTunnelUrl || url

    if (devConfig.autoLaunch !== false) {
      await openBrowser({ url, log, silentBrowserNoneError: true })
    }

    await reportAnalytics({ config: this.config, settings })

    process.env.URL = url
    process.env.DEPLOY_URL = url

    printBanner({ url, log })
  }
}

DevCommand.description = `Local dev server
The dev command will run a local dev server with Netlify's proxy and redirect rules
`

DevCommand.examples = ['$ netlify dev', '$ netlify dev -c "yarn start"', '$ netlify dev -c hugo']

DevCommand.strict = false

DevCommand.flags = {
  command: flagsLib.string({
    char: 'c',
    description: 'command to run',
  }),
  port: flagsLib.integer({
    char: 'p',
    description: 'port of netlify dev',
  }),
  targetPort: flagsLib.integer({
    description: 'port of target app server',
  }),
  staticServerPort: flagsLib.integer({
    description: 'port of the static app server used when no framework is detected',
    hidden: true,
  }),
  dir: flagsLib.string({
    char: 'd',
    description: 'dir with static files',
  }),
  functions: flagsLib.string({
    char: 'f',
    description: 'Specify a functions folder to serve',
  }),
  offline: flagsLib.boolean({
    char: 'o',
    description: 'disables any features that require network access',
  }),
  live: flagsLib.boolean({
    char: 'l',
    description: 'Start a public live session',
  }),
  trafficMesh: flagsLib.boolean({
    char: 't',
    hidden: true,
    description: 'Uses Traffic Mesh for proxying requests',
  }),
  ...DevCommand.flags,
}

module.exports = DevCommand
