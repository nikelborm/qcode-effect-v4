/** biome-ignore-all lint/correctness/useHookAtTopLevel: because it's not React.js */

// Local mode — the default: scan ~/projects, pick with fzf, open in VS Code.

import * as Effect from 'effect/Effect'
import { pipe } from 'effect/Function'
import * as HashSet from 'effect/HashSet'
import * as Path from 'effect/Path'
import * as Stream from 'effect/Stream'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import { isNotFound, logErrorOnNotFound, PROJECTS_DIR } from './common.ts'

export const DIR_ICON = '\ue5ff' // 
export const WORKSPACE_ICON = '\ue8da' // 

export const PRUNE_DIRS = [
  ['node_modules', '__fixtures__', '__mocks__', '__pycache__', '__snapshots__'],
  ['__test__', '__tests__', '.cache', '.cargo', '.claude', 'temporary', 'gen'],
  ['.expo', '.gradle', '.husky', '.idea', '.netlify', '.next', '.nx', '.specs'],
  ['.nyc_output', '.parcel-cache', 'fixtures', '.serverless', '.venv', 'out'],
  ['integration-tests', '.swc', '.turbo', '.vercel', '.yarn', 'build', 'built'],
  ['specs', 'target', 'temp', 'test', 'dist-types', 'tests', 'vendor', 'venv'],
  ['temp_full_cache', '.docusaurus', 'coverage', 'generated', 'release', 'tmp'],
  ['cache', 'classes', 'third_party', 'testing', 'storybook-static', 'dist'],
  ['.pnpm-store', '.stryker-tmp', 'logs', 'output'],
  // the last 3 here because they're too heavy. They will still be listed anyway
  // because they're in root directory, we just wont search for subdirectories
  ['firefox', 'mdn-content', 'base-ui'],
].flat()

export const README_FILES = ['README', 'Readme', 'readme']
  .flatMap(r =>
    ['', 'ru', 'RU', 'en', 'EN'].map(ext => (ext ? r + '.' + ext : r)),
  )
  .flatMap(r => ['', 'md', 'txt'].map(ext => (ext ? r + '.' + ext : r)))

export const PRUNE_ARGS = PRUNE_DIRS.map(e => `-name ${e}`).join(' -o ')

// TODO: add error message queue, so that it doesn't mess with fzf's on screen output

const areSomeDependenciesMissing = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const depResults = yield* Effect.forEach(
    Object.entries({
      eza: 'modern ls replacement — https://github.com/eza-community/eza',
      bat: 'syntax-highlighting cat — https://github.com/sharkdp/bat',
    }),
    ([name, hint]) =>
      pipe(
        ChildProcess.make('which', [name]),
        spawner.exitCode,
        Effect.map(code => ({ name, hint, isPresent: (code as number) === 0 })),
      ),
    { concurrency: 'unbounded' },
  )

  const missingDeps = depResults.filter(r => !r.isPresent)

  if (missingDeps.length > 0) {
    for (const { name, hint } of missingDeps)
      yield* Effect.logError(`Missing required tool '${name}': ${hint}`)

    return true
  }

  return false
})

export const find = (args: string) => {
  const stream = (main: string, message: string) =>
    ChildProcessSpawner.ChildProcessSpawner.useSync(spawner =>
      spawner.streamLines(
        ChildProcess.make(main, [PROJECTS_DIR, ...args.split(' ')]),
      ),
    ).pipe(Stream.unwrap, Stream.tapError(logErrorOnNotFound(message)))

  return stream(
    'bfs',
    'Breadth-first finder (`bfs` binary) is not found. Read more here: https://github.com/tavianator/bfs, https://terminaltrove.com/bfs/. The script will attempt to fallback to find',
  ).pipe(
    Stream.catchIf(isNotFound, () =>
      stream(
        'find',
        '`find` binary is not found. Read more here: https://www.man7.org/linux/man-pages/man1/find.1.html',
      ),
    ),
  )
}

// -H to follow if the "projects" is a symlink somewhere

// SPACES around parentheses are important!!
export const gitAndVsCodeDirPaths = find(
  `-H -type d ( ${PRUNE_ARGS} ) -prune -o -type d ( -name .git -o -name .vscode ) -prune -print`,
)

export const packageJsonAndMiseTomlAndCodeWorkspacePaths = find(
  `-H -type d ( ${PRUNE_ARGS} -o -name .git ) -prune -o -type f ( -name package.json -o -name mise.toml -o -name *.code-workspace ) -print`,
)

export const dirAndCodeWorkspacePathsInProjectsRoot = find(
  '-H -maxdepth 1 -mindepth 1 ( -type d -o -name *.code-workspace )',
)

const dedupStreamHashedSimple = <A, E, R>(
  self: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> =>
  Stream.mapAccum(
    self,
    () => HashSet.empty<A>(),
    (alreadyEmitted, value) =>
      HashSet.has(alreadyEmitted, value)
        ? [alreadyEmitted, [] as A[]]
        : [HashSet.add(alreadyEmitted, value), [value]],
  )

export const vscodeArgCandidates = pipe(
  [
    gitAndVsCodeDirPaths,
    packageJsonAndMiseTomlAndCodeWorkspacePaths,
    dirAndCodeWorkspacePathsInProjectsRoot,
  ],
  Stream.mergeAll({ concurrency: 'unbounded' }),
  Stream.map(currentLine =>
    currentLine.endsWith('.code-workspace')
      ? currentLine
      : currentLine
          .replace('package.json', '')
          .replace('mise.toml', '')
          .replace('.git', '')
          .replace('.vscode', '')
          // adds slash at the end
          .replace(/[^/]+$/, '$&/'),
  ),
  dedupStreamHashedSimple,
)

export const hyperlink = (uri: string, text: string) =>
  `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`

const ansiBlue = (s: string) => `\x1b[34m${s}\x1b[0m`
const ansiGreen = (s: string) => `\x1b[32m${s}\x1b[0m`

export const fzfPrettyCandidates = vscodeArgCandidates.pipe(
  Stream.mapEffect(vscodeArgCandidate =>
    Path.Path.useSync(path => ({
      path: path.relative(PROJECTS_DIR, vscodeArgCandidate),
      isDir: vscodeArgCandidate.endsWith('/'),
    })),
  ),
  Stream.map(({ isDir, path }) => {
    const color = isDir ? ansiBlue : ansiGreen
    const icon = isDir ? DIR_ICON : WORKSPACE_ICON
    return hyperlink(`file://${path}`, color(`${icon} ${path}\n`))
  }),
)

// fzf replaces {2} with the raw relative path (second space-delimited field),
// while the first icon is discarded.
export const PREVIEW_CMD = `\
path=${PROJECTS_DIR}/{2}
if [ -d "$path" ]; then
  cd "$path"
  for file in ${README_FILES.join(' ')}; do
    if [ -f "$file" ]; then
      PAGER="" bat --style=plain --color=always "$file"
      echo
      break
    fi
  done
  echo
  eza -labgM --group-directories-first --no-time --octal-permissions \\
      --classify=always --icons=always --color-scale=size \\
      --color-scale-mode=gradient --color=always --hyperlink \\
      --smart-group --no-quotes -h ./
else
  bat --style=plain --language=json --color=always "$path"
fi`

export const localMode = Effect.gen(function* () {
  if (yield* areSomeDependenciesMissing) return ChildProcessSpawner.ExitCode(1)

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const fzfProcess = yield* ChildProcess.make(
    'fzf',
    [
      '--ansi',
      '--delimiter= ',
      '--preview-window=50%',
      `--preview=${PREVIEW_CMD}`,
    ],
    { stderr: 'inherit' },
  ).pipe(
    spawner.spawn,
    Effect.tapError(
      logErrorOnNotFound(
        'Fuzzy finder (`fzf` binary) is not found. Read more here: https://github.com/junegunn/fzf.',
      ),
    ),
  )

  const [fzfExitCode, selectedLine] = yield* Effect.all(
    [
      fzfProcess.exitCode,
      fzfProcess.stdout.pipe(Stream.decodeText, Stream.mkString),
      Stream.run(Stream.encodeText(fzfPrettyCandidates), fzfProcess.stdin),
    ],
    { concurrency: 'unbounded' },
  )

  if ((fzfExitCode as number) === 130) {
    yield* Effect.log('fzf canceled by user')
    return ChildProcessSpawner.ExitCode(0)
  } else if ((fzfExitCode as number) !== 0) {
    yield* Effect.logError('fzf exited with non-zero code: ', fzfExitCode)
    return ChildProcessSpawner.ExitCode(1)
  }

  const relativePath = selectedLine.split(' ')[1]?.trim()

  if (!relativePath) {
    yield* Effect.logError('failed to parse relative path returned by fzf')
    return ChildProcessSpawner.ExitCode(1)
  }

  const path = yield* Path.Path

  const vscodeLauncherExitCode = yield* pipe(
    ChildProcess.make('code', [path.join(PROJECTS_DIR, relativePath)], {
      stdout: 'inherit',
      stderr: 'inherit',
    }),
    spawner.exitCode,
    Effect.tapError(
      logErrorOnNotFound(
        'VS Code (`code` binary) is not found. Are you using VS Code Insiders?',
      ),
    ),
  )

  if ((vscodeLauncherExitCode as number) !== 0) {
    yield* Effect.logError(
      'vs code launcher exited with non-zero code: ',
      vscodeLauncherExitCode,
    )

    return ChildProcessSpawner.ExitCode(1)
  }

  return ChildProcessSpawner.ExitCode(0)
}).pipe(Effect.scoped, Effect.withSpan('qcode.local'))
