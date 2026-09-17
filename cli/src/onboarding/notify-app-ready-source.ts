import type { NotifyAppReadyProject } from './notify-app-ready-project'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { NodeTypes, parse as parseVue } from '@vue/compiler-dom'
import ts from 'typescript'

const UPDATER_PACKAGE = '@capgo/capacitor-updater'
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|vue)$/
const EXCLUDED_DIRECTORY = /^(?:\..*|node_modules|dist|build|www|coverage|android|ios|test|tests|__tests__|__mocks__|fixtures|__fixtures__|e2e|cypress|playwright|scripts)$/
const EXCLUDED_FILE = /\.(?:test|spec|d)\.[cm]?[jt]sx?$|^capacitor\.config\./

function contained(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`)
}

function compilerOptions(dir: string): ts.CompilerOptions {
  const path = ts.findConfigFile(dir, ts.sys.fileExists)
  if (!path)
    return {}
  const config = ts.readConfigFile(path, ts.sys.readFile)
  if (config.error)
    return {}
  return ts.parseJsonConfigFileContent({ ...config.config, files: [], include: [] }, ts.sys, dirname(path)).options
}

function vueScripts(content: string): string {
  // Only script blocks are JavaScript; markup/comments must not complete a todo.
  const root = parseVue(content, { parseMode: 'sfc', onError: error => { throw error } })
  return root.children.flatMap((node) => {
    if (node.type !== NodeTypes.ELEMENT || node.tag !== 'script')
      return []
    return node.children.flatMap(child => child.type === NodeTypes.TEXT ? [child.content] : [])
  }).join('\n')
}

function importDeclaration(node: ts.Node): ts.ImportDeclaration | undefined {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isImportDeclaration(parent))
      return parent
  }
  return undefined
}

function updaterImport(node: ts.Node): boolean {
  const declaration = importDeclaration(node)
  return !!declaration && ts.isStringLiteral(declaration.moduleSpecifier)
    && declaration.moduleSpecifier.text === UPDATER_PACKAGE
    && !declaration.importClause?.isTypeOnly
}

function isUpdaterReference(node: ts.Expression, checker: ts.TypeChecker): boolean {
  if (ts.isIdentifier(node)) {
    return !!checker.getSymbolAtLocation(node)?.declarations?.some((declaration) => {
      if (ts.isImportSpecifier(declaration)) {
        return !declaration.isTypeOnly && (declaration.propertyName ?? declaration.name).text === 'CapacitorUpdater'
          && updaterImport(declaration)
      }
      if (!ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent))
        return false
      const variable = declaration.parent.parent
      const name = declaration.propertyName ?? declaration.name
      if (!ts.isIdentifier(name) || name.text !== 'CapacitorUpdater' || !ts.isVariableDeclaration(variable))
        return false
      const initializer = variable.initializer
      return !!initializer && ts.isCallExpression(initializer)
        && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'require'
        && !checker.getSymbolAtLocation(initializer.expression)
        && initializer.arguments.length === 1 && ts.isStringLiteral(initializer.arguments[0])
        && initializer.arguments[0].text === UPDATER_PACKAGE
        && ts.isVariableDeclarationList(variable.parent) && !!(variable.parent.flags & ts.NodeFlags.Const)
    })
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'CapacitorUpdater' && ts.isIdentifier(node.expression)) {
    return !!checker.getSymbolAtLocation(node.expression)?.declarations?.some(declaration =>
      ts.isNamespaceImport(declaration) && updaterImport(declaration),
    )
  }
  return false
}

function hasCall(source: ts.SourceFile, checker: ts.TypeChecker): boolean {
  function visit(node: ts.Node): boolean {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'notifyAppReady'
        && isUpdaterReference(callee.expression, checker)) {
        return true
      }
      if (ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
        && callee.argumentExpression.text === 'notifyAppReady' && isUpdaterReference(callee.expression, checker)) {
        return true
      }
    }
    return ts.forEachChild(node, visit) ?? false
  }
  return visit(source)
}

export function scanNotifyAppReadySource(project: NotifyAppReadyProject): 'found' | 'not_found' | 'unknown' {
  try {
    const deadline = Date.now() + 5_000
    const contents = new Map<string, string>()
    const originalPaths = new Map<string, string>()
    const seen = new Set<string>()
    const options = compilerOptions(project.dir)
    let bytes = 0
    const checkBudget = () => {
      if (Date.now() > deadline || seen.size > 10_000 || bytes > 20 * 1024 * 1024)
        throw new Error('Source scan budget exceeded')
    }
    function addFile(path: string): void {
      checkBudget()
      if (!SOURCE_EXTENSION.test(path) || EXCLUDED_FILE.test(basename(path)))
        return
      const canonical = realpathSync(path)
      if (seen.has(canonical) || !contained(project.workspaceRoot, canonical)
        || relative(project.workspaceRoot, canonical).split(sep).some(part => EXCLUDED_DIRECTORY.test(part))
        || (project.webDir && project.webDir !== project.dir && contained(project.webDir, canonical))) {
        return
      }
      seen.add(canonical)
      const size = statSync(canonical).size
      if (size > 1024 * 1024)
        throw new Error('Source file too large')
      bytes += size
      checkBudget()
      const content = readFileSync(canonical, 'utf8')
      const normalizedPath = canonical.split(sep).join('/')
      const virtualPath = extname(canonical) === '.vue' ? `${normalizedPath}.tsx` : normalizedPath
      const script = extname(canonical) === '.vue' ? vueScripts(content) : content
      contents.set(virtualPath, script)
      originalPaths.set(virtualPath, canonical)
    }
    function walk(dir: string): void {
      checkBudget()
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          // Other workspace packages/apps are only followed through imports.
          if (!EXCLUDED_DIRECTORY.test(entry.name) && !existsSync(join(path, 'package.json')))
            walk(path)
        }
        else if (entry.isFile()) {
          addFile(path)
        }
      }
    }
    walk(project.dir)

    // Follow local shared modules, including tsconfig paths and workspace symlinks.
    for (const [virtualPath, content] of contents) {
      checkBudget()
      const original = originalPaths.get(virtualPath)!
      for (const imported of ts.preProcessFile(content, true, true).importedFiles) {
        const name = imported.fileName
        if (name === UPDATER_PACKAGE)
          continue
        const resolved = ts.resolveModuleName(name, original, options, ts.sys).resolvedModule?.resolvedFileName
          ?? (name.startsWith('.') && SOURCE_EXTENSION.test(name) ? resolve(dirname(original), name) : undefined)
        if (resolved && existsSync(resolved))
          addFile(resolved)
      }
    }

    const parseOptions: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: true, types: [], jsx: ts.JsxEmit.Preserve }
    const host = ts.createCompilerHost(parseOptions)
    host.getSourceFile = (path, languageVersion) => {
      const content = contents.get(path)
      return content === undefined ? undefined : ts.createSourceFile(path, content, languageVersion, true)
    }
    const program = ts.createProgram([...contents.keys()], parseOptions, host)
    const checker = program.getTypeChecker()
    let unknown = false
    for (const source of program.getSourceFiles()) {
      checkBudget()
      if (program.getSyntacticDiagnostics(source).length) {
        unknown = true
        continue
      }
      if (hasCall(source, checker))
        return 'found'
    }
    return unknown ? 'unknown' : 'not_found'
  }
  catch {
    return 'unknown'
  }
}
