import * as child_process from "child_process";
import * as readline from "readline";
import * as vscode from "vscode";
import type * as git from "./git";

const summaryCharLimit = 50;
const maxLineDecorations = 100;

let log: vscode.LogOutputChannel;
let blameDecoration: vscode.TextEditorDecorationType;
let gitApi: git.API;

const cache = new Map<string, Repository>();

interface Repository {
  gitRepo: git.Repository,
  email: string;
  head: Ref;
  files: Map<string, File>;
  commits: Map<Sha, Commit>;
}

interface File {
  blame: Ref[] | "untracked"; // refs indexed by 0-based line number
  state: "loading" | "done" | "dirty";
  pendingChanges: vscode.TextDocumentContentChangeEvent[];
  pendingEditors: Set<vscode.TextEditor>;
}

type Sha = string;
const Uncommitted = Symbol();
type Ref = Sha | typeof Uncommitted;

interface Commit {
  author: string;
  email: string;
  timestamp: number; // Unix timestamp in seconds
  summary: string;
  message?: string; // loaded on demand
}

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    log = vscode.window.createOutputChannel("Git Line Blame", { log: true }),
    blameDecoration = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
      after: {
        color: new vscode.ThemeColor("gitlineblame.foregroundColor"),
        margin: "0 0 0 3em",
      },
    })
  );
  const extension = vscode.extensions.getExtension<git.GitExtension>("vscode.git");
  if (!extension) {
    log.appendLine("not in a git repository");
    return;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  const api = exports.getAPI(1);
  api.onDidChangeState(async (state) => {
    if (state !== "initialized") return;
    log.appendLine(`git API initialized with ${api.repositories.length} repo(s)`);
    gitApi = api;
    for (const repo of api.repositories) cache.set(repo.rootUri.fsPath, {
      gitRepo: repo,
      email: (await gitStdout(repo, ["config", "user.email"])).trim(),
      head: repo.state.HEAD?.commit ?? Uncommitted,
      files: new Map(),
      commits: new Map(),
    });
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(onDidOpenTextDocument),
      vscode.workspace.onDidSaveTextDocument(onDidSaveTextDocument),
      vscode.workspace.onDidChangeTextDocument(onDidChangeTextDocument),
      vscode.window.onDidChangeTextEditorSelection(onDidChangeTextEditorSelection),
      vscode.commands.registerCommand("git-line-blame.clearCache", commandClearCache),
      vscode.commands.registerTextEditorCommand("git-line-blame.reblameFile", commandReblameFile),
    );
    updateEditor(vscode.window.activeTextEditor);
    await Promise.all(
      vscode.window.visibleTextEditors.map((editor) => onDidOpenTextDocument(editor.document))
    );
    let numFiles = 0;
    for (const repo of cache.values()) numFiles += repo.files.size;
    log.appendLine(`blamed ${numFiles} initial file(s)`);
    updateEditor(vscode.window.activeTextEditor);
  });
}

export function deactivate() { cache.clear(); }

function commandClearCache() { for (const repo of cache.values()) repo.files.clear(); }

function commandReblameFile(editor: vscode.TextEditor) {
  const repo = getRepo(editor.document.uri);
  if (!repo) return;
  loadFile(repo, editor.document, editor);
  updateEditor(editor);
}

function onDidOpenTextDocument(document: vscode.TextDocument) {
  const repo = getRepo(document.uri);
  if (repo && !repo.files.has(document.uri.fsPath)) loadFile(repo, document);
}

function onDidSaveTextDocument(document: vscode.TextDocument) {
  const repo = getRepo(document.uri);
  if (!repo) return;
  const file = repo.files.get(document.uri.fsPath);
  if (!file) return;
  if (file.state === "dirty") reloadFile(repo, file, document);
  updateEditor(vscode.window.activeTextEditor);
}

function loadFile(repo: Repository, document: vscode.TextDocument, ...editors: vscode.TextEditor[]) {
  const file: File = { blame: [], state: "loading", pendingChanges: [], pendingEditors: new Set(editors) };
  const path = document.uri.fsPath;
  repo.files.set(path, file);
  if (document.isDirty) file.state = "dirty"; else loadBlameForFile(repo, file, path);
  return file;
}

function reloadFile(repo: Repository, file: File, document: vscode.TextDocument, ...editors: vscode.TextEditor[]) {
  if (file.state === "loading") return;
  file.blame = [];
  file.state = "loading";
  file.pendingChanges = [];
  file.pendingEditors = new Set(editors);
  if (document.isDirty) file.state = "dirty"; else loadBlameForFile(repo, file, document.uri.fsPath);
}

function onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent) {
  const repo = getRepo(event.document.uri);
  if (!repo) return;
  const document = event.document;
  const file = repo.files.get(document.uri.fsPath);
  if (file === undefined || file.blame === "untracked") return;
  if (file.state === "loading")
    file.pendingChanges.push(...event.contentChanges);
  else if (file.state === "done")
    for (const change of event.contentChanges) processChange(file, change, document);
}

function processChange(file: File, change: vscode.TextDocumentContentChangeEvent, document?: vscode.TextDocument) {
  if (file.blame === "untracked") return;
  const start = change.range.start.line;
  const end = change.range.end.line;
  const lines = change.text.split("\n");
  const newEnd = start + lines.length - 1;
  const inc = change.text.charAt(0) === "\n" && document && document.lineAt(newEnd).text.length === lines[lines.length - 1].length;
  const dec = change.text === "" && document && document.lineAt(start).text.length === change.range.start.character;
  const dec2 = change.text.charAt(change.text.length - 1) === "\n" && document && change.range.start.character === 0;
  log.appendLine(`change text="${change.text}" start=${change.range.start.line}:${change.range.start.character} end=${change.range.end.line}:${change.range.end.character} inc=${inc} dec=${dec} dec2=${dec2} start=${start} end=${end} newEnd=${newEnd}`);
  // for (let i = start + (inc || dec2 ? 1 : 0); i <= Math.min(end, newEnd) - (dec ? 1 : 0); i++) file.blame[i] = Uncommitted;
  if (newEnd < end) file.blame.splice(newEnd + 1, end - newEnd);
  else if (newEnd > end) file.blame.splice(end + 1, 0, ...Array(newEnd - end).fill(Uncommitted));
}

function updateEditor(editor?: vscode.TextEditor) {
  if (editor) return onDidChangeTextEditorSelection({ textEditor: editor, selections: editor.selections, kind: undefined });
}

async function onDidChangeTextEditorSelection(event: vscode.TextEditorSelectionChangeEvent) {
  const editor = event.textEditor;
  const repo = getRepo(editor.document.uri);
  if (!repo) return;
  const path = editor.document.uri.fsPath;
  const file = repo.files.get(path) ?? loadFile(repo, editor.document, editor);
  if (file.blame === "untracked") return editor.setDecorations(blameDecoration, []);
  const startLine = event.selections[0].start.line;
  const endLine = event.selections[0].end.line;
  const actualHead = repo.gitRepo.state.HEAD?.commit;
  if (repo.head !== actualHead) {
    const newHead = actualHead ?? Uncommitted;
    log.append(`detected HEAD change from ${String(repo.head)} to ${String(newHead)}`);
    repo.head = newHead;
    repo.files.clear();
    reloadFile(repo, file, editor.document, editor);
  }
  const decorationOptions = [];
  let lastRef = null;
  const limit = startLine + maxLineDecorations;
  const logPromises = [];
  for (let i = startLine; i <= endLine; i++) {
    const ref = file.blame[i];
    if (ref === lastRef) continue;
    lastRef = ref;
    const end = editor.document.lineAt(i).range.end;
    const option = {
      range: new vscode.Range(end, end),
      renderOptions: {
        after: { contentText: undefined as string | undefined },
      },
      hoverMessage: undefined as vscode.MarkdownString[] | undefined,
    };
    if (i > limit) {
      option.renderOptions.after.contentText = "(Exceeded git blame limit)";
      decorationOptions.push(option);
      break;
    }
    let commit;
    if (file.state === "dirty") {
      option.renderOptions.after.contentText = "(Save to blame)";
    } else if (ref === undefined) {
      if (i !== editor.document.lineCount - 1) option.renderOptions.after.contentText = "Loading blame…";
    } else if (ref === Uncommitted) {
      option.renderOptions.after.contentText = "You • Uncommitted changes";
    } else if ((commit = repo.commits.get(ref)) === undefined) {
      option.renderOptions.after.contentText =
        "(Failed to get git blame information)";
    } else {
      const when = friendlyTimestamp(commit.timestamp);
      option.renderOptions.after.contentText = `${commit.author}, ${when} • ${commit.summary}`;
      if (commit.message === undefined) {
        logPromises.push((async () => {
          commit.message = await gitStdout(repo.gitRepo, ["show", "-s", "--format=%B", ref]);
          option.hoverMessage = buildHoverMessage(ref, commit, when, path);
        })());
      } else {
        option.hoverMessage = buildHoverMessage(ref, commit, when, path);
      }
    }
    decorationOptions.push(option);
  }
  if (file.state === "loading") file.pendingEditors.add(editor);
  await Promise.all(logPromises);
  editor.setDecorations(blameDecoration, decorationOptions);
}

function buildHoverMessage(sha: Sha, commit: Commit, when: string, path: string) {
  const command = vscode.Uri.from({
    scheme: "command",
    path: "vscode.diff",
    query: JSON.stringify([gitUri(sha + "~", path), gitUri(sha, path)]),
  });
  return [
    trusted(`**${commit.author}** [${commit.email}](mailto:${commit.email}), ${when} (${isoDate(commit.timestamp)})\n\n${commit.message}`),
    trusted(`[Diff](${command}): ${sha}`),
  ];
}

function gitUri(ref: Sha, path: string) {
  return vscode.Uri.from({
    scheme: "git",
    path: path,
    query: JSON.stringify({ ref, path }),
  });
}

function trusted(str: string) {
  const markdown = new vscode.MarkdownString(str);
  markdown.isTrusted = true;
  return markdown;
}

function getRepo(uri: vscode.Uri) {
  if (!gitApi) return;
  if (uri.scheme !== "file") return;
  const gitRepo = gitApi.getRepository(uri);
  if (!gitRepo) {
    log.appendLine(`ERROR: no repo found for file: ${uri}`);
    return;
  }
  const root = gitRepo.rootUri.fsPath;
  const repo = cache.get(root);
  if (!repo) {
    log.appendLine(`ERROR: repo not found in cache: ${root}`);
    return;
  }
  return repo;
}

async function loadBlameForFile(repo: Repository, file: File, path: string) {
  log.appendLine(`loading blame: ${path}`);
  const proc = gitSpawn(repo.gitRepo, ["blame", "--incremental", "--", path]);
  const exitCode = new Promise(resolve => proc.on("close", resolve));
  const blame = file.blame as Ref[];
  let expectSha = true;
  let commit = undefined;
  for await (const line of readline.createInterface({ input: proc.stdout })) {
    if (expectSha) {
      expectSha = false;
      const words = line.split(" ");
      const sha = words[0];
      const ref = sha === "0000000000000000000000000000000000000000" ? Uncommitted : sha;
      const start = parseInt(words[2]) - 1;
      const num = parseInt(words[3]);
      for (let i = start; i < start + num; i++) blame[i] = ref;
      if (ref !== Uncommitted && !repo.commits.has(sha))
        repo.commits.set(sha, commit = {} as Commit);
      else
        commit = undefined;
      continue;
    }
    const idx = line.indexOf(" ");
    const tag = line.substring(0, idx);
    if (tag === "filename") {
      expectSha = true;
      continue;
    }
    if (!commit) continue;
    const content = line.substring(idx + 1);
    switch (tag) {
      case "author":
        if (!commit.author) commit.author = content;
        break;
      case "author-mail":
        commit.email = content.replace(/[<>]/g, "");
        if (commit.email === repo.email) commit.author = "You";
        break;
      case "author-time":
        commit.timestamp = parseInt(content);
        break;
      case "summary":
        commit.summary = truncateEllipsis(content.trim(), summaryCharLimit);
        break;
    }
  }
  const code = await exitCode;
  if (code === 128)
    file.blame = "untracked";
  else if (code !== 0)
    log.appendLine(`ERROR: git blame failed with exit code ${code}`);
  file.state = "done";
  for (const change of file.pendingChanges) processChange(file, change);
  file.pendingChanges = [];
  const editors = Array.from(file.pendingEditors);
  file.pendingEditors.clear();
  await Promise.all(editors.map(updateEditor));
}

function gitSpawn(repo: git.Repository, args: string[], onClose?: (code: number) => void) {
  const fullArgs = ["-C", repo.rootUri.fsPath, ...args];
  const proc = child_process.spawn(gitApi.git.path, fullArgs);
  proc.on("close", onClose ?? ((code) => {
    if (code !== 0) log.appendLine(`ERROR: ${JSON.stringify(proc.spawnargs)} failed with exit code ${code}`);
  }));
  return proc;
}

async function gitStdout(repo: git.Repository, args: string[]) {
  let result = "";
  for await (const data of gitSpawn(repo, args).stdout) result += data;
  return result;
}

function isoDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString(undefined, { dateStyle: "medium" });
}

function friendlyTimestamp(timestamp: number) {
  const s = Math.round(Date.now() / 1000 - timestamp);
  if (s < 30) return "just now";
  const m = s / 60;
  if (m < 1) return Math.round(s) + " seconds ago";
  if (m < 1.5) return "a minute ago";
  const h = m / 60;
  if (h < 1) return Math.round(m) + " minutes ago";
  if (h < 1.5) return "an hour ago";
  const d = h / 24;
  if (d < 1) return Math.round(h) + " hours ago";
  if (d < 1.5) return "yesterday";
  const w = d / 7;
  if (w < 1) return Math.round(d) + " days ago";
  if (w < 1.5) return "last week";
  const mm = w / 4.3333333333;
  if (mm < 1) return Math.round(w) + " weeks ago";
  if (mm < 1.5) return "last month";
  const y = d / 365.25;
  if (y < 1) return Math.round(mm) + " months ago";
  if (y < 1.5) return "last year";
  return Math.round(y) + " years ago";
}

function truncateEllipsis(str: string, maxLen: number) {
  return str.length <= maxLen ? str : str.substring(0, maxLen - 1) + "…";
}
