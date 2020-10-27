const { listFunctions } = require('@netlify/zip-it-and-ship-it')

const { fileExistsAsync } = require('../lib/fs')

// List all Netlify Functions
const getFunctions = async function (functionsSrcDir) {
  if (!(await fileExistsAsync(functionsSrcDir))) {
    return []
  }

  const functions = await listFunctions(functionsSrcDir)
  const functionsWithProps = functions.map(addFunctionProps)
  return functionsWithProps
}

const addFunctionProps = function ({ name }) {
  const localPath = getLocalFunctionPath(name)
  const isBackground = name.endsWith(BACKGROUND)
  return { name, localPath, isBackground }
}

const getLocalFunctionPath = function (functionName) {
  return `/.netlify/functions/${functionName}`
}

const BACKGROUND = '-background'

module.exports = { getFunctions }
