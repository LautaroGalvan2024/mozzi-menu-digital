import { acceptedEnvironmentKeys, AcceptanceSafetyError, validateAcceptanceEnvironment } from './staging-safety.mjs'

// No dotenv, file access, process spawning or network before full validation.
try {
  validateAcceptanceEnvironment(process.env)
  if (process.argv.slice(2).some(argument => argument !== '--validate-only') || process.argv.length > 3) {
    throw new AcceptanceSafetyError('Only --validate-only is accepted; test/config overrides are refused')
  }
  if (process.argv.includes('--validate-only')) {
    console.log('STAGING_ACCEPTANCE configuration valid; no services contacted')
  } else {
    const [{ spawn }, { mkdtemp, rm }, { tmpdir }, path, { fileURLToPath }, { randomBytes }] = await Promise.all([
      import('node:child_process'), import('node:fs/promises'), import('node:os'), import('node:path'), import('node:url'), import('node:crypto'),
    ])
    const directory = path.dirname(fileURLToPath(import.meta.url))
    const workspace = path.resolve(directory, '../..')
    const output = await mkdtemp(path.join(tmpdir(), 'mozzi-acceptance-'))
    const env = {}
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'LANG', 'PLAYWRIGHT_BROWSERS_PATH']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    for (const key of acceptedEnvironmentKeys) if (process.env[key] !== undefined) env[key] = process.env[key]
    env.MOZZI_ACCEPTANCE_LAUNCH = randomBytes(32).toString('hex')
    env.MOZZI_ACCEPTANCE_OUTPUT = output
    env.CI = '1'
    try {
      const child = spawn(process.execPath, [path.join(workspace, 'node_modules/@playwright/test/cli.js'),
        'test', '--config', path.join(workspace, 'playwright.staging.config.ts')], {
        cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      // Failures can include submitted passwords or tokens. Only the dedicated
      // reporter's fixed status lines may reach stdout; all raw diagnostics stay private.
      let buffered = ''
      child.stdout.on('data', chunk => {
        buffered = (buffered + chunk.toString('utf8')).slice(-8192)
        const lines = buffered.split('\n'); buffered = lines.pop() ?? ''
        for (const line of lines) if (/^STAGING_ACCEPTANCE (test (passed|failed|skipped|timedOut|interrupted)|summary total=\d+ passed=\d+ failed=\d+ skipped=\d+|runner error)$/.test(line.trim())) console.log(line.trim())
      })
      child.stderr.on('data', () => {})
      const code = await new Promise(resolve => { child.once('error', () => resolve(1)); child.once('exit', value => resolve(value ?? 1)) })
      process.exitCode = code
      if (code !== 0) console.error('STAGING_ACCEPTANCE refused or failed; raw diagnostics and credential-bearing artifacts withheld')
    } finally {
      const expectedParent = path.resolve(tmpdir())
      if (path.dirname(path.resolve(output)) === expectedParent && path.basename(output).startsWith('mozzi-acceptance-')) {
        await rm(output, { force: true, recursive: true })
      } else { process.exitCode = 1; console.error('Acceptance cleanup path refused') }
    }
  }
} catch (error) {
  console.error(error instanceof AcceptanceSafetyError ? error.message : 'Acceptance run failed; private diagnostics withheld')
  process.exitCode = 1
}
