import { relative, basename, extname, dirname, join } from 'path';
import { Module } from 'module';
import * as util from 'util';
import { fileURLToPath } from 'url';

import type * as _sourceMapSupport from '@cspotcode/source-map-support';
import type * as _ts from 'typescript';

import {
  cachedLookup,
  createProjectLocalResolveHelper,
  hasOwnProperty,
  normalizeSlashes,
  once,
  parse,
  ProjectLocalResolveHelper,
  split,
  versionGteLt,
  yn,
} from './util';
import { findAndReadConfig, loadCompiler } from './configuration';
import type { TSCommon, TSInternal } from './ts-compiler-types';
import { createModuleTypeClassifier, ModuleTypeClassifier } from './module-type-classifier';
import { createResolverFunctions } from './resolver-functions';
import type { createEsmHooks as createEsmHooksFn } from './esm';
import { installCommonjsResolveHooksIfNecessary, ModuleConstructorWithInternals } from './cjs-resolve-hooks';
import { classifyModule } from './node-module-type-classifier';
import type * as _nodeInternalModulesEsmResolve from '../dist-raw/node-internal-modules-esm-resolve';
import type * as _nodeInternalModulesEsmGetFormat from '../dist-raw/node-internal-modules-esm-get_format';
import type * as _nodeInternalModulesCjsLoader from '../dist-raw/node-internal-modules-cjs-loader';
import { Extensions, getExtensions } from './file-extensions';
import { createTsTranspileModule } from './ts-transpile-module';
import { assertScriptCanLoadAsCJS } from '../dist-raw/node-internal-modules-cjs-loader';

export { TSCommon };
export type { NodeLoaderHooksAPI1, NodeLoaderHooksAPI2, NodeLoaderHooksFormat } from './esm';

const engineSupportsPackageTypeField = true;

/**
 * Registered `ts-node` instance information.
 */
export const REGISTER_INSTANCE = Symbol.for('ts-node.register.instance');

/**
 * Expose `REGISTER_INSTANCE` information on node.js `process`.
 */
declare global {
  namespace NodeJS {
    interface Process {
      [REGISTER_INSTANCE]?: Service;
    }
  }
}

/** @internal */
export const env = process.env as ProcessEnv;
/**
 * Declare all env vars, to aid discoverability.
 * If an env var affects ts-node's behavior, it should not be buried somewhere in our codebase.
 * @internal
 */
export interface ProcessEnv {
  TS_NODE_DEBUG?: string;
  TS_NODE_CWD?: string;
  /** @deprecated */
  TS_NODE_DIR?: string;
  TS_NODE_SCOPE?: string;
  TS_NODE_SCOPE_DIR?: string;
  TS_NODE_PRETTY?: string;
  TS_NODE_COMPILER?: string;
  TS_NODE_COMPILER_OPTIONS?: string;
  TS_NODE_IGNORE?: string;
  TS_NODE_PROJECT?: string;
  TS_NODE_SKIP_PROJECT?: string;
  TS_NODE_SKIP_IGNORE?: string;
  TS_NODE_PREFER_TS_EXTS?: string;
  TS_NODE_LOG_ERROR?: string;
  TS_NODE_HISTORY?: string;

  NODE_NO_READLINE?: string;
}

/**
 * @internal
 */
export const INSPECT_CUSTOM = util.inspect.custom || 'inspect';

/**
 * Debugging `ts-node`.
 */
const shouldDebug = yn(env.TS_NODE_DEBUG);
/** @internal */
export const debug = shouldDebug
  ? (...args: any) => console.log(`[ts-node ${new Date().toISOString()}]`, ...args)
  : () => undefined;
const debugFn = shouldDebug
  ? <T, U>(key: string, fn: (arg: T) => U) => {
      let i = 0;
      return (x: T) => {
        debug(key, x, ++i);
        return fn(x);
      };
    }
  : <T, U>(_: string, fn: (arg: T) => U) => fn;

/**
 * Export the current version.
 */
export const VERSION = require('../package.json').version;

/**
 * Options for creating a new TypeScript compiler instance.

 * @category Basic
 */
export interface CreateOptions {
  /**
   * Behave as if invoked within this working directory.  Roughly equivalent to `cd $dir && ts-node ...`
   *
   * @default process.cwd()
   */
  cwd?: string;
  /**
   * Legacy alias for `cwd`
   *
   * @deprecated use `projectSearchDir` or `cwd`
   */
  dir?: string;
  /**
   * Scope compiler to files within `scopeDir`.
   *
   * @default false
   */
  scope?: boolean;
  /**
   * @default First of: `tsconfig.json` "rootDir" if specified, directory containing `tsconfig.json`, or cwd if no `tsconfig.json` is loaded.
   */
  scopeDir?: string;
  /**
   * Use pretty diagnostic formatter.
   *
   * @default false
   */
  pretty?: boolean;
  /**
   * Logs TypeScript errors to stderr instead of throwing exceptions.
   *
   * @default false
   */
  logError?: boolean;
  /**
   * Specify a custom TypeScript compiler.
   *
   * @default "typescript"
   */
  compiler?: string;
  /**
   * Paths which should not be compiled.
   *
   * Each string in the array is converted to a regular expression via `new RegExp()` and tested against source paths prior to compilation.
   *
   * Source paths are normalized to posix-style separators, relative to the directory containing `tsconfig.json` or to cwd if no `tsconfig.json` is loaded.
   *
   * Default is to ignore all node_modules subdirectories.
   *
   * @default ["(?:^|/)node_modules/"]
   */
  ignore?: string[];
  /**
   * Path to TypeScript config file or directory containing a `tsconfig.json`.
   * Similar to the `tsc --project` flag: https://www.typescriptlang.org/docs/handbook/compiler-options.html
   */
  project?: string;
  /**
   * Search for TypeScript config file (`tsconfig.json`) in this or parent directories.
   */
  projectSearchDir?: string;
  /**
   * Skip project config resolution and loading.
   *
   * @default false
   */
  skipProject?: boolean;
  /**
   * Skip ignore check, so that compilation will be attempted for all files with matching extensions.
   *
   * @default false
   */
  skipIgnore?: boolean;
  /**
   * JSON object to merge with TypeScript `compilerOptions`.
   *
   * @allOf [{"$ref": "https://schemastore.azurewebsites.net/schemas/json/tsconfig.json#definitions/compilerOptionsDefinition/properties/compilerOptions"}]
   */
  compilerOptions?: object;
  /**
   * Modules to require, like node's `--require` flag.
   *
   * If specified in `tsconfig.json`, the modules will be resolved relative to the `tsconfig.json` file.
   *
   * If specified programmatically, each input string should be pre-resolved to an absolute path for
   * best results.
   */
  require?: Array<string>;
  readFile?: (path: string) => string | undefined;
  fileExists?: (path: string) => boolean;
  /**
   * Override certain paths to be compiled and executed as CommonJS or ECMAScript modules.
   * When overridden, the tsconfig "module" and package.json "type" fields are overridden, and
   * the file extension is ignored.
   * This is useful if you cannot use .mts, .cts, .mjs, or .cjs file extensions;
   * it achieves the same effect.
   *
   * Each key is a glob pattern following the same rules as tsconfig's "include" array.
   * When multiple patterns match the same file, the last pattern takes precedence.
   *
   * `cjs` overrides matches files to compile and execute as CommonJS.
   * `esm` overrides matches files to compile and execute as native ECMAScript modules.
   * `package` overrides either of the above to default behavior, which obeys package.json "type" and
   * tsconfig.json "module" options.
   */
  moduleTypes?: ModuleTypes;
  /**
   * @internal
   * Set by our configuration loader whenever a config file contains options that
   * are relative to the config file they came from, *and* when other logic needs
   * to know this.  Some options can be eagerly resolved to absolute paths by
   * the configuration loader, so it is *not* necessary for their source to be set here.
   */
  optionBasePaths?: OptionBasePaths;
  /**
   * A function to collect trace messages from the TypeScript compiler, for example when `traceResolution` is enabled.
   *
   * @default console.log
   */
  tsTrace?: (str: string) => void;
  /**
   * Enable native ESM support.
   *
   * For details, see https://typestrong.org/ts-node/docs/imports#native-ecmascript-modules
   */
  esm?: boolean;
  /**
   * Re-order file extensions so that TypeScript imports are preferred.
   *
   * For example, when both `index.js` and `index.ts` exist, enabling this option causes `require('./index')` to resolve to `index.ts` instead of `index.js`
   *
   * @default false
   */
  preferTsExts?: boolean;
  /**
   * Like node's `--experimental-specifier-resolution`, , but can also be set in your `tsconfig.json` for convenience.
   *
   * For details, see https://nodejs.org/dist/latest-v18.x/docs/api/esm.html#customizing-esm-specifier-resolution-algorithm
   */
  experimentalSpecifierResolution?: 'node' | 'explicit';
  /**
   * Allow using voluntary `.ts` file extension in import specifiers.
   *
   * Typically, in ESM projects, import specifiers must have an emit extension, `.js`, `.cjs`, or `.mjs`,
   * and we automatically map to the corresponding `.ts`, `.cts`, or `.mts` source file.  This is the
   * recommended approach.
   *
   * However, if you really want to use `.ts` in import specifiers, and are aware that this may
   * break tooling, you can enable this flag.
   */
  experimentalTsImportSpecifiers?: boolean;
}

export type ModuleTypes = Record<string, ModuleTypeOverride>;
export type ModuleTypeOverride = 'cjs' | 'esm' | 'package';

/** @internal */
export interface OptionBasePaths {
  moduleTypes?: string;
  compiler?: string;
}

/**
 * Options for registering a TypeScript compiler instance globally.

 * @category Basic
 */
export interface RegisterOptions extends CreateOptions {
  /**
   * Enable experimental features that re-map imports and require calls to support:
   * `baseUrl`, `paths`, `rootDirs`, `.js` to `.ts` file extension mappings,
   * `outDir` to `rootDir` mappings for composite projects and monorepos.
   *
   * For details, see https://github.com/TypeStrong/ts-node/issues/1514
   */
  experimentalResolver?: boolean;
}

export type ExperimentalSpecifierResolution = 'node' | 'explicit';

/**
 * Must be an interface to support `typescript-json-schema`.
 */
export interface TsConfigOptions
  extends Omit<
    RegisterOptions,
    | 'readFile'
    | 'fileExists'
    | 'skipProject'
    | 'project'
    | 'dir'
    | 'cwd'
    | 'projectSearchDir'
    | 'optionBasePaths'
    | 'tsTrace'
  > {}

/**
 * Information retrieved from type info check.
 */
export interface TypeInfo {
  name: string;
  comment: string;
}

/**
 * Default register options, including values specified via environment
 * variables.
 * @internal
 */
export const DEFAULTS: RegisterOptions = {
  cwd: env.TS_NODE_CWD ?? env.TS_NODE_DIR,
  scope: yn(env.TS_NODE_SCOPE),
  scopeDir: env.TS_NODE_SCOPE_DIR,
  pretty: yn(env.TS_NODE_PRETTY),
  compiler: env.TS_NODE_COMPILER,
  compilerOptions: parse(env.TS_NODE_COMPILER_OPTIONS),
  ignore: split(env.TS_NODE_IGNORE),
  project: env.TS_NODE_PROJECT,
  skipProject: yn(env.TS_NODE_SKIP_PROJECT),
  skipIgnore: yn(env.TS_NODE_SKIP_IGNORE),
  preferTsExts: yn(env.TS_NODE_PREFER_TS_EXTS),
  logError: yn(env.TS_NODE_LOG_ERROR),
  tsTrace: console.log.bind(console),
};

/**
 * TypeScript diagnostics error.
 */
export class TSError extends Error {
  name = 'TSError';
  diagnosticText!: string;
  diagnostics!: ReadonlyArray<_ts.Diagnostic>;

  constructor(
    diagnosticText: string,
    public diagnosticCodes: number[],
    diagnostics: ReadonlyArray<_ts.Diagnostic> = []
  ) {
    super(`⨯ Unable to compile TypeScript:\n${diagnosticText}`);
    Object.defineProperty(this, 'diagnosticText', {
      configurable: true,
      writable: true,
      value: diagnosticText,
    });
    Object.defineProperty(this, 'diagnostics', {
      configurable: true,
      writable: true,
      value: diagnostics,
    });
  }

  /**
   * @internal
   */
  [INSPECT_CUSTOM]() {
    return this.diagnosticText;
  }
}

const TS_NODE_SERVICE_BRAND = Symbol('TS_NODE_SERVICE_BRAND');

/**
 * Primary ts-node service, which wraps the TypeScript API and can compile TypeScript to JavaScript
 */
export interface Service {
  /** @internal */
  [TS_NODE_SERVICE_BRAND]: true;
  ts: TSCommon;
  /** @internal */
  compilerPath: string;
  config: _ts.ParsedCommandLine;
  options: RegisterOptions;
  enabled(enabled?: boolean): boolean;
  ignored(fileName: string): boolean;
  compile(code: string, fileName: string, lineOffset?: number): string;
  /** @internal */
  configFilePath: string | undefined;
  /** @internal */
  moduleTypeClassifier: ModuleTypeClassifier;
  /** @internal */
  addDiagnosticFilter(filter: DiagnosticFilter): void;
  /** @internal */
  installSourceMapSupport(): void;
  /** @internal */
  projectLocalResolveHelper: ProjectLocalResolveHelper;
  /** @internal */
  getNodeEsmResolver: () => ReturnType<typeof import('../dist-raw/node-internal-modules-esm-resolve').createResolve>;
  /** @internal */
  getNodeEsmGetFormat: () => ReturnType<
    typeof import('../dist-raw/node-internal-modules-esm-get_format').createGetFormat
  >;
  /** @internal */
  getNodeCjsLoader: () => ReturnType<typeof import('../dist-raw/node-internal-modules-cjs-loader').createCjsLoader>;
  /** @internal */
  extensions: Extensions;
}

/**
 * Re-export of `Service` interface for backwards-compatibility
 * @deprecated use `Service` instead
 * @see {Service}
 */
export type Register = Service;

/** @internal */
export interface DiagnosticFilter {
  /** if true, filter applies to all files */
  appliesToAllFiles: boolean;
  /** Filter applies onto to these filenames.  Only used if appliesToAllFiles is false */
  filenamesAbsolute: string[];
  /** these diagnostic codes are ignored */
  diagnosticsIgnored: number[];
}

/**
 * Create a new TypeScript compiler instance and register it onto node.js
 *
 * @category Basic
 */
export function register(opts?: RegisterOptions): Service;
/**
 * Register TypeScript compiler instance onto node.js

 * @category Basic
 */
export function register(service: Service): Service;
export function register(serviceOrOpts: Service | RegisterOptions | undefined): Service {
  // Is this a Service or a RegisterOptions?
  let service = serviceOrOpts as Service;
  if (!(serviceOrOpts as Service)?.[TS_NODE_SERVICE_BRAND]) {
    // Not a service; is options
    service = create((serviceOrOpts ?? {}) as RegisterOptions);
  }

  const originalJsHandler = require.extensions['.js'];

  // Expose registered instance globally.
  process[REGISTER_INSTANCE] = service;

  // Register the extensions.
  registerExtensions(service.options.preferTsExts, service.extensions.compiled, service, originalJsHandler);

  installCommonjsResolveHooksIfNecessary(service);

  service.installSourceMapSupport();

  // Require specified modules before start-up.
  (Module as ModuleConstructorWithInternals)._preloadModules(service.options.require);

  return service;
}

/**
 * Create TypeScript compiler instance.
 *
 * @category Basic
 */
export function create(rawOptions: CreateOptions = {}): Service {
  const foundConfigResult = findAndReadConfig(rawOptions);
  return createFromPreloadedConfig(foundConfigResult);
}

/** @internal */
export function createFromPreloadedConfig(foundConfigResult: ReturnType<typeof findAndReadConfig>): Service {
  const { configFilePath, cwd, options, config, compiler, projectLocalResolveDir, optionBasePaths } = foundConfigResult;

  const projectLocalResolveHelper = createProjectLocalResolveHelper(projectLocalResolveDir);

  const ts = loadCompiler(compiler);
  const diagnosticFilters: Array<DiagnosticFilter> = [
    {
      appliesToAllFiles: true,
      filenamesAbsolute: [],
      diagnosticsIgnored: [
        6059, // "'rootDir' is expected to contain all source files."
        18002, // "The 'files' list in config file is empty."
        18003, // "No inputs were found in config file."
        ...(options.experimentalTsImportSpecifiers
          ? [
              2691, // "An import path cannot end with a '.ts' extension. Consider importing '<specifier without ext>' instead."
            ]
          : []),
      ].map(Number),
    },
  ];

  const configDiagnosticList = filterDiagnostics(config.errors, diagnosticFilters);
  const outputCache = new Map<
    string,
    {
      content: string;
    }
  >();

  const configFileDirname = configFilePath ? dirname(configFilePath) : null;
  const scopeDir = options.scopeDir ?? config.options.rootDir ?? configFileDirname ?? cwd;
  const ignoreBaseDir = configFileDirname ?? cwd;
  const isScoped = options.scope ? (fileName: string) => relative(scopeDir, fileName).charAt(0) !== '.' : () => true;
  const shouldIgnore = createIgnore(
    ignoreBaseDir,
    options.skipIgnore ? [] : (options.ignore || ['(?:^|/)node_modules/']).map((str) => new RegExp(str))
  );

  const diagnosticHost: _ts.FormatDiagnosticsHost = {
    getNewLine: () => ts.sys.newLine,
    getCurrentDirectory: () => cwd,
    // TODO switch to getCanonicalFileName we already create later in scope
    getCanonicalFileName: ts.sys.useCaseSensitiveFileNames ? (x) => x : (x) => x.toLowerCase(),
  };

  // Install source map support and read from memory cache.
  function installSourceMapSupport() {
    const sourceMapSupport = require('@cspotcode/source-map-support') as typeof _sourceMapSupport;
    sourceMapSupport.install({
      environment: 'node',
      retrieveFile(pathOrUrl: string) {
        let path = pathOrUrl;
        // If it's a file URL, convert to local path
        // I could not find a way to handle non-URLs except to swallow an error
        if (path.startsWith('file://')) {
          try {
            path = fileURLToPath(path);
          } catch (e) {
            /* swallow error */
          }
        }
        path = normalizeSlashes(path);
        return outputCache.get(path)?.content || '';
      },
      redirectConflictingLibrary: true,
      onConflictingLibraryRedirect(request, parent, isMain, options, redirectedRequest) {
        debug(
          `Redirected an attempt to require source-map-support to instead receive @cspotcode/source-map-support.  "${
            (parent as NodeJS.Module).filename
          }" attempted to require or resolve "${request}" and was redirected to "${redirectedRequest}".`
        );
      },
    });
  }

  const shouldHavePrettyErrors = options.pretty === undefined ? process.stdout.isTTY : options.pretty;

  const formatDiagnostics = shouldHavePrettyErrors
    ? ts.formatDiagnosticsWithColorAndContext || ts.formatDiagnostics
    : ts.formatDiagnostics;

  function createTSError(diagnostics: ReadonlyArray<_ts.Diagnostic>) {
    const diagnosticText = formatDiagnostics(diagnostics, diagnosticHost);
    const diagnosticCodes = diagnostics.map((x) => x.code);
    return new TSError(diagnosticText, diagnosticCodes, diagnostics);
  }

  function reportTSError(configDiagnosticList: _ts.Diagnostic[]) {
    const error = createTSError(configDiagnosticList);
    if (options.logError) {
      // Print error in red color and continue execution.
      console.error('\x1b[31m%s\x1b[0m', error);
    } else {
      // Throw error and exit the script.
      throw error;
    }
  }

  // Render the configuration errors.
  if (configDiagnosticList.length) reportTSError(configDiagnosticList);

  const jsxEmitPreserve = config.options.jsx === ts.JsxEmit.Preserve;
  /**
   * Get the extension for a transpiled file.
   * [MUST_UPDATE_FOR_NEW_FILE_EXTENSIONS]
   */
  function getEmitExtension(path: string) {
    const lastDotIndex = path.lastIndexOf('.');
    if (lastDotIndex >= 0) {
      const ext = path.slice(lastDotIndex);
      switch (ext) {
        case '.js':
        case '.ts':
          return '.js';
        case '.jsx':
        case '.tsx':
          return jsxEmitPreserve ? '.jsx' : '.js';
        case '.mjs':
        case '.mts':
          return '.mjs';
        case '.cjs':
        case '.cts':
          return '.cjs';
      }
    }
    return '.js';
  }

  type GetOutputFunction = (code: string, fileName: string) => SourceOutput;
  /**
   * Get output from TS compiler w/typechecking.  `undefined` in `transpileOnly`
   * mode.
   */
  let getOutput: GetOutputFunction | undefined;

  const getCanonicalFileName = (ts as unknown as TSInternal).createGetCanonicalFileName(
    ts.sys.useCaseSensitiveFileNames
  );

  const moduleTypeClassifier = createModuleTypeClassifier({
    basePath: options.optionBasePaths?.moduleTypes,
    patterns: options.moduleTypes,
  });

  const extensions = getExtensions(config, options, ts.version);

  function createTranspileOnlyGetOutputFunction(
    overrideModuleType?: _ts.ModuleKind,
    nodeModuleEmitKind?: NodeModuleEmitKind
  ): GetOutputFunction {
    const compilerOptions = { ...config.options };
    if (overrideModuleType !== undefined) compilerOptions.module = overrideModuleType;
    let tsTranspileModule = versionGteLt(ts.version, '4.7.0')
      ? createTsTranspileModule(ts, {
          compilerOptions,
          reportDiagnostics: true,
        })
      : undefined;
    return (code: string, fileName: string): SourceOutput => {
      let result: _ts.TranspileOutput;
      if (tsTranspileModule) {
        result = tsTranspileModule(
          code,
          {
            fileName,
          },
          nodeModuleEmitKind === 'nodeesm' ? 'module' : 'commonjs'
        );
      } else {
        result = ts.transpileModule(code, {
          fileName,
          compilerOptions,
          reportDiagnostics: true,
        });
      }

      const diagnosticList = filterDiagnostics(result.diagnostics || [], diagnosticFilters);
      if (diagnosticList.length) reportTSError(diagnosticList);

      return [result.outputText, result.sourceMapText ?? '{}', false];
    };
  }

  // When true, these mean that a `moduleType` override will cause a different emit
  // than the TypeScript compiler, so we *must* overwrite the emit.
  const shouldOverwriteEmitWhenForcingCommonJS = config.options.module !== ts.ModuleKind.CommonJS;
  // [MUST_UPDATE_FOR_NEW_MODULEKIND]
  const shouldOverwriteEmitWhenForcingEsm = !(
    config.options.module === ts.ModuleKind.ES2015 ||
    (ts.ModuleKind.ES2020 && config.options.module === ts.ModuleKind.ES2020) ||
    (ts.ModuleKind.ES2022 && config.options.module === ts.ModuleKind.ES2022) ||
    config.options.module === ts.ModuleKind.ESNext
  );
  /**
   * node16 or nodenext
   * [MUST_UPDATE_FOR_NEW_MODULEKIND]
   */
  const isNodeModuleType =
    (ts.ModuleKind.Node16 && config.options.module === ts.ModuleKind.Node16) ||
    (ts.ModuleKind.NodeNext && config.options.module === ts.ModuleKind.NodeNext);
  const getOutputForceCommonJS = createTranspileOnlyGetOutputFunction(ts.ModuleKind.CommonJS);
  const getOutputForceNodeCommonJS = createTranspileOnlyGetOutputFunction(ts.ModuleKind.NodeNext, 'nodecjs');
  const getOutputForceNodeESM = createTranspileOnlyGetOutputFunction(ts.ModuleKind.NodeNext, 'nodeesm');
  // [MUST_UPDATE_FOR_NEW_MODULEKIND]
  const getOutputForceESM = createTranspileOnlyGetOutputFunction(
    ts.ModuleKind.ES2022 || ts.ModuleKind.ES2020 || ts.ModuleKind.ES2015
  );
  const getOutputTranspileOnly = createTranspileOnlyGetOutputFunction();

  // Create a simple TypeScript compiler proxy.
  function compile(code: string, fileName: string, lineOffset = 0) {
    const normalizedFileName = normalizeSlashes(fileName);
    const classification = moduleTypeClassifier.classifyModuleByModuleTypeOverrides(normalizedFileName);
    let value: string | undefined = '';
    let sourceMap: string | undefined = '';

    // If module classification contradicts the above, call the relevant transpiler
    if (classification.moduleType === 'cjs') {
      [value, sourceMap] = getOutputForceCommonJS(code, normalizedFileName);
    } else if (classification.moduleType === 'esm') {
      [value, sourceMap] = getOutputForceESM(code, normalizedFileName);
    } else {
      // Happens when ts compiler skips emit or in transpileOnly mode
      const classification = classifyModule(fileName, isNodeModuleType);
      [value, sourceMap] =
        classification === 'nodecjs'
          ? getOutputForceNodeCommonJS(code, normalizedFileName)
          : classification === 'nodeesm'
          ? getOutputForceNodeESM(code, normalizedFileName)
          : classification === 'cjs'
          ? getOutputForceCommonJS(code, normalizedFileName)
          : classification === 'esm'
          ? getOutputForceESM(code, normalizedFileName)
          : getOutputTranspileOnly(code, normalizedFileName);
    }
    const output = updateOutput(value!, normalizedFileName, sourceMap!, getEmitExtension);
    outputCache.set(normalizedFileName, { content: output });
    return output;
  }

  let active = true;
  const enabled = (enabled?: boolean) => (enabled === undefined ? active : (active = !!enabled));
  const ignored = (fileName: string) => {
    if (!active) return true;
    const ext = extname(fileName);
    if (extensions.compiled.includes(ext)) {
      return !isScoped(fileName) || shouldIgnore(fileName);
    }
    return true;
  };

  function addDiagnosticFilter(filter: DiagnosticFilter) {
    diagnosticFilters.push({
      ...filter,
      filenamesAbsolute: filter.filenamesAbsolute.map((f) => normalizeSlashes(f)),
    });
  }

  const getNodeEsmResolver = once(() =>
    (require('../dist-raw/node-internal-modules-esm-resolve') as typeof _nodeInternalModulesEsmResolve).createResolve({
      extensions,
      preferTsExts: options.preferTsExts,
      tsNodeExperimentalSpecifierResolution: options.experimentalSpecifierResolution,
    })
  );
  const getNodeEsmGetFormat = once(() =>
    (
      require('../dist-raw/node-internal-modules-esm-get_format') as typeof _nodeInternalModulesEsmGetFormat
    ).createGetFormat(options.experimentalSpecifierResolution, getNodeEsmResolver())
  );
  const getNodeCjsLoader = once(() =>
    (require('../dist-raw/node-internal-modules-cjs-loader') as typeof _nodeInternalModulesCjsLoader).createCjsLoader({
      extensions,
      preferTsExts: options.preferTsExts,
      nodeEsmResolver: getNodeEsmResolver(),
    })
  );

  return {
    [TS_NODE_SERVICE_BRAND]: true,
    ts,
    compilerPath: compiler,
    config,
    compile,
    ignored,
    enabled,
    options,
    configFilePath,
    moduleTypeClassifier,
    addDiagnosticFilter,
    installSourceMapSupport,
    projectLocalResolveHelper,
    getNodeEsmResolver,
    getNodeEsmGetFormat,
    getNodeCjsLoader,
    extensions,
  };
}

/**
 * Check if the filename should be ignored.
 */
function createIgnore(ignoreBaseDir: string, ignore: RegExp[]) {
  return (fileName: string) => {
    const relname = relative(ignoreBaseDir, fileName);
    const path = normalizeSlashes(relname);

    return ignore.some((x) => x.test(path));
  };
}

/**
 * Register the extensions to support when importing files.
 */
function registerExtensions(
  preferTsExts: boolean | null | undefined,
  extensions: string[],
  service: Service,
  originalJsHandler: (m: NodeModule, filename: string) => any
) {
  const exts = new Set(extensions);
  // Can't add these extensions cuz would allow omitting file extension; node requires ext for .cjs and .mjs
  // Unless they're already registered by something else (nyc does this):
  // then we *must* hook them or else our transformer will not be called.
  for (const cannotAdd of ['.mts', '.cts', '.mjs', '.cjs']) {
    if (exts.has(cannotAdd) && !hasOwnProperty(require.extensions, cannotAdd)) {
      // Unrecognized file exts can be transformed via the `.js` handler.
      exts.add('.js');
      exts.delete(cannotAdd);
    }
  }

  // Register new extensions.
  for (const ext of exts) {
    registerExtension(ext, service, originalJsHandler);
  }

  if (preferTsExts) {
    const preferredExtensions = new Set([...exts, ...Object.keys(require.extensions)]);

    // Re-sort iteration order of Object.keys()
    for (const ext of preferredExtensions) {
      const old = Object.getOwnPropertyDescriptor(require.extensions, ext);
      delete require.extensions[ext];
      Object.defineProperty(require.extensions, ext, old!);
    }
  }
}

/**
 * Register the extension for node.
 */
function registerExtension(ext: string, service: Service, originalHandler: (m: NodeModule, filename: string) => any) {
  const old = require.extensions[ext] || originalHandler;

  require.extensions[ext] = function (m: any, filename) {
    if (service.ignored(filename)) return old(m, filename);

    assertScriptCanLoadAsCJS(service, m, filename);

    const _compile = m._compile;

    m._compile = function (code: string, fileName: string) {
      debug('module._compile', fileName);

      const result = service.compile(code, fileName);
      return _compile.call(this, result, fileName);
    };

    return old(m, filename);
  };
}

/**
 * Internal source output.
 */
type SourceOutput = [string, string, false] | [undefined, undefined, true];

/**
 * Update the output remapping the source map.
 */
function updateOutput(
  outputText: string,
  fileName: string,
  sourceMap: string,
  getEmitExtension: (fileName: string) => string
) {
  const base64Map = Buffer.from(updateSourceMap(sourceMap, fileName), 'utf8').toString('base64');
  const sourceMapContent = `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64Map}`;
  // Expected form: `//# sourceMappingURL=foo bar.js.map` or `//# sourceMappingURL=foo%20bar.js.map` for input file "foo bar.tsx"
  // Percent-encoding behavior added in TS 4.1.1: https://github.com/microsoft/TypeScript/issues/40951
  const prefix = '//# sourceMappingURL=';
  const prefixLength = prefix.length;
  const baseName = /*foo.tsx*/ basename(fileName);
  const extName = /*.tsx*/ extname(fileName);
  const extension = /*.js*/ getEmitExtension(fileName);
  const sourcemapFilename = baseName.slice(0, -extName.length) + extension + '.map';
  const sourceMapLengthWithoutPercentEncoding = prefixLength + sourcemapFilename.length;
  /*
   * Only rewrite if existing directive exists at the location we expect, to support:
   *   a) compilers that do not append a sourcemap directive
   *   b) situations where we did the math wrong
   *     Not ideal, but appending our sourcemap *after* a pre-existing sourcemap still overrides, so the end-user is happy.
   */
  if (outputText.substr(-sourceMapLengthWithoutPercentEncoding, prefixLength) === prefix) {
    return outputText.slice(0, -sourceMapLengthWithoutPercentEncoding) + sourceMapContent;
  }
  // If anyone asks why we're not using URL, the URL equivalent is: `u = new URL('http://d'); u.pathname = "/" + sourcemapFilename; return u.pathname.slice(1);
  const sourceMapLengthWithPercentEncoding = prefixLength + encodeURI(sourcemapFilename).length;
  if (outputText.substr(-sourceMapLengthWithPercentEncoding, prefixLength) === prefix) {
    return outputText.slice(0, -sourceMapLengthWithPercentEncoding) + sourceMapContent;
  }

  return `${outputText}\n${sourceMapContent}`;
}

/**
 * Update the source map contents for improved output.
 */
function updateSourceMap(sourceMapText: string, fileName: string) {
  const sourceMap = JSON.parse(sourceMapText);
  sourceMap.file = fileName;
  sourceMap.sources = [fileName];
  delete sourceMap.sourceRoot;
  return JSON.stringify(sourceMap);
}

/**
 * Filter diagnostics.
 */
function filterDiagnostics(diagnostics: readonly _ts.Diagnostic[], filters: DiagnosticFilter[]) {
  return diagnostics.filter((d) =>
    filters.every(
      (f) =>
        (!f.appliesToAllFiles && f.filenamesAbsolute.indexOf(d.file?.fileName!) === -1) ||
        f.diagnosticsIgnored.indexOf(d.code) === -1
    )
  );
}

/**
 * Create an implementation of node's ESM loader hooks.
 *
 * This may be useful if you
 * want to wrap or compose the loader hooks to add additional functionality or
 * combine with another loader.
 *
 * Node changed the hooks API, so there are two possible APIs.  This function
 * detects your node version and returns the appropriate API.
 *
 * @category ESM Loader
 */
export const createEsmHooks: typeof createEsmHooksFn = (tsNodeService: Service) =>
  (require('./esm') as typeof import('./esm')).createEsmHooks(tsNodeService);

/**
 * When using `module: nodenext` or `module: node12`, there are two possible styles of emit depending in file extension or package.json "type":
 *
 * - CommonJS with dynamic imports preserved (not transformed into `require()` calls)
 * - ECMAScript modules with `import foo = require()` transformed into `require = createRequire(); const foo = require()`
 */
export type NodeModuleEmitKind = 'nodeesm' | 'nodecjs';
