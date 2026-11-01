// The TUI app's command-line provider: parses the dsh --profile tui flag
// family (--resume, --model, --provider, --sidebar) and its --help text, then
// provides the immutable values as the tuiStartup service. Ordinary rows
// inject that service and read it as a lazily-resolved value.
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveLocale, setLocale, t } from './i18n.js'

export const name = 'dsh-oc-tui/startup'
export const inject = ['cmdlineArgs']
export const TUI_STARTUP_SERVICE = 'tuiStartup'

// The command line is parsed before the plugin applies, so the settings file is
// not readable here: the help text follows the environment (DSH_TUI_LOCALE, or
// the OS language) and the boot itself then re-resolves the stored preference.
try { setLocale(resolveLocale('system')) } catch { /* the help falls back to English */ }

function tuiCommand() {
  return new Command()
    .name('dsh --profile tui')
    .description(t('startup.description'))
    .helpOption('-h, --help', t('startup.helpOption'))
    .option('--resume <sessionId>', t('startup.resume'))
    .option('--model <modelId>', t('startup.model'))
    .option('--provider <provider>', t('startup.provider'))
    .option('--sidebar', t('startup.sidebar'))
    .option('--no-sidebar', t('startup.noSidebar'))
    .addHelpText('after', `
${t('startup.examples')}
  dsh --profile tui                      ${t('startup.exampleFresh')}
  dsh --profile tui --resume abc123      ${t('startup.exampleResume')}
  dsh --profile tui --model deepseek-v4-flash
`)
}

export function apply(ctx) {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts()
    ctx.provide(TUI_STARTUP_SERVICE, {
      resume: options.resume ?? null,
      model: options.model ?? null,
      provider: options.provider ?? null,
      sidebar: options.sidebar !== false,
    })
  })
  parseCmdline(ctx, program)
}
