import * as vscode from 'vscode';
import simpleGit, { SimpleGit, LogResult } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';

interface CommitDetail {
	date: Date;
	message: string;
	hash: string;
}

interface DayWork {
	day: string;
	firstCommit: Date;
	lastCommit: Date;
	hours: number;
	commits: CommitDetail[];
}

interface WorkRecord {
	author: string;
	commits: number;
	commitDetails: CommitDetail[];
	dailyWork: DayWork[];
	totalHours: number;
}

class WorkHoursViewProvider implements vscode.WebviewViewProvider {
	constructor(private readonly _extensionUri: vscode.Uri) {}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		console.log('WorkHoursViewProvider.resolveWebviewView 被调用');
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtmlContent();
		console.log('Webview HTML 已设置');

		webviewView.webview.onDidReceiveMessage(async message => {
			if (message.command === 'upload') {
				const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
				if (!workspaceFolder) {
					vscode.window.showErrorMessage('请先打开一个工作区');
					return;
				}

				const git: SimpleGit = simpleGit(workspaceFolder.uri.fsPath);
				try {
					const log: LogResult = await git.log(message.since ? { '--after': `${message.since} 00:00:00` } : {});
					const records = new Map<string, WorkRecord>();

					log.all.forEach(commit => {
						const author = commit.author_name;
						if (!records.has(author)) {
							records.set(author, { author, commits: 0, commitDetails: [], dailyWork: [], totalHours: 0 });
						}
						const record = records.get(author)!;
						record.commits++;
						record.commitDetails.push({ date: new Date(commit.date), message: commit.message, hash: commit.hash });
					});

					records.forEach(record => {
						record.commitDetails.sort((a, b) => a.date.getTime() - b.date.getTime());
						const dayMap = new Map<string, CommitDetail[]>();
						record.commitDetails.forEach(commit => {
							const day = commit.date.toLocaleDateString();
							if (!dayMap.has(day)) dayMap.set(day, []);
							dayMap.get(day)!.push(commit);
						});
						dayMap.forEach((commits, day) => {
							const first = commits[0].date;
							const last = commits[commits.length - 1].date;
							const hours = (last.getTime() - first.getTime()) / (1000 * 60 * 60);
							record.dailyWork.push({ day, firstCommit: first, lastCommit: last, hours, commits });
							record.totalHours += hours;
						});
					});

					vscode.window.showInformationMessage(`工时数据已准备完成（模拟上传）\n总工时: ${Array.from(records.values()).reduce((sum, r) => sum + r.totalHours, 0).toFixed(2)} 小时`);
				} catch (error) {
					vscode.window.showErrorMessage(`读取 Git 记录失败: ${error}`);
				}
			}
		});
	}

	private getHtmlContent(): string {
		return `<!DOCTYPE html>
<html>
<head>
<style>
body{padding:10px;font-family:Arial}
.section{margin:20px 0}
label{display:block;margin-bottom:5px;font-weight:bold}
input{width:100%;padding:8px;box-sizing:border-box;margin-bottom:15px}
button{width:100%;padding:10px;background:#007acc;color:white;border:none;cursor:pointer;font-size:14px}
button:hover{background:#005a9e}
.info{background:#f0f0f0;padding:10px;border-radius:4px;margin-top:15px;font-size:12px}
</style>
</head>
<body>
<div class="section">
<label>统计起始日期</label>
<input type="date" id="sinceDate" placeholder="留空则统计全部">
</div>
<button onclick="upload()">上传工时到服务器</button>
<div class="info">
<strong>说明：</strong><br>
点击上传按钮将统计工时数据并上传到服务器（当前为模拟功能）
</div>
<script>
const vscode=acquireVsCodeApi();
function upload(){
const since=document.getElementById('sinceDate').value;
vscode.postMessage({command:'upload',since:since||null});
}
</script>
</body>
</html>`;
	}
}

export function activate(context: vscode.ExtensionContext) {
	console.log('工时记录插件已激活');

	const provider = new WorkHoursViewProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('workhoursrecordView', provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	const showWorkHours = vscode.commands.registerCommand('workhoursrecord.showWorkHours', async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('请先打开一个工作区');
			return;
		}

		const git: SimpleGit = simpleGit(workspaceFolder.uri.fsPath);

		try {
			const since = await vscode.window.showInputBox({
				prompt: '输入统计起始日期（格式：YYYY-MM-DD，留空则统计全部）',
				placeHolder: '例如：2025-01-01'
			});

			const log: LogResult = await git.log(since ? { '--after': `${since} 00:00:00` } : {});
			const records = new Map<string, WorkRecord>();

			log.all.forEach(commit => {
				const author = commit.author_name;
				if (!records.has(author)) {
					records.set(author, {
						author,
						commits: 0,
						commitDetails: [],
						dailyWork: [],
						totalHours: 0
					});
				}
				const record = records.get(author)!;
				record.commits++;
				record.commitDetails.push({
					date: new Date(commit.date),
					message: commit.message,
					hash: commit.hash
				});
			});

			records.forEach(record => {
				record.commitDetails.sort((a, b) => a.date.getTime() - b.date.getTime());
				const dayMap = new Map<string, CommitDetail[]>();
				record.commitDetails.forEach(commit => {
					const day = commit.date.toLocaleDateString();
					if (!dayMap.has(day)) {
						dayMap.set(day, []);
					}
					dayMap.get(day)!.push(commit);
				});

				dayMap.forEach((commits, day) => {
					const first = commits[0].date;
					const last = commits[commits.length - 1].date;
					const hours = (last.getTime() - first.getTime()) / (1000 * 60 * 60);
					record.dailyWork.push({ day, firstCommit: first, lastCommit: last, hours, commits });
					record.totalHours += hours;
				});
				record.dailyWork.sort((a, b) => a.firstCommit.getTime() - b.firstCommit.getTime());
			});

			showWorkHourPanel(context, records);
		} catch (error) {
			vscode.window.showErrorMessage(`读取 Git 记录失败: ${error}`);
		}
	});

	const exportCSV = vscode.commands.registerCommand('workhoursrecord.exportCSV', async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('请先打开一个工作区');
			return;
		}

		const git: SimpleGit = simpleGit(workspaceFolder.uri.fsPath);

		try {
			const since = await vscode.window.showInputBox({
				prompt: '输入统计起始日期（格式：YYYY-MM-DD，留空则统计全部）',
				placeHolder: '例如：2025-01-01'
			});

			const log: LogResult = await git.log(since ? { '--after': `${since} 00:00:00` } : {});
			const records = new Map<string, WorkRecord>();

			log.all.forEach(commit => {
				const author = commit.author_name;
				if (!records.has(author)) {
					records.set(author, {
						author,
						commits: 0,
						commitDetails: [],
						dailyWork: [],
						totalHours: 0
					});
				}
				const record = records.get(author)!;
				record.commits++;
				record.commitDetails.push({
					date: new Date(commit.date),
					message: commit.message,
					hash: commit.hash
				});
			});

			records.forEach(record => {
				record.commitDetails.sort((a, b) => a.date.getTime() - b.date.getTime());
				const dayMap = new Map<string, CommitDetail[]>();
				record.commitDetails.forEach(commit => {
					const day = commit.date.toLocaleDateString();
					if (!dayMap.has(day)) {
						dayMap.set(day, []);
					}
					dayMap.get(day)!.push(commit);
				});

				dayMap.forEach((commits, day) => {
					const first = commits[0].date;
					const last = commits[commits.length - 1].date;
					const hours = (last.getTime() - first.getTime()) / (1000 * 60 * 60);
					record.dailyWork.push({ day, firstCommit: first, lastCommit: last, hours, commits });
					record.totalHours += hours;
				});
				record.dailyWork.sort((a, b) => a.firstCommit.getTime() - b.firstCommit.getTime());
			});

			let csv = '开发者,日期,工作时长(小时),首次提交,最后提交,提交次数,提交时间,任务内容,提交哈希\n';
			records.forEach(record => {
				record.dailyWork.forEach(day => {
					day.commits.forEach(commit => {
						const msg = commit.message.replace(/"/g, '""');
						csv += `"${record.author}","${day.day}",${day.hours.toFixed(2)},"${day.firstCommit.toLocaleTimeString()}","${day.lastCommit.toLocaleTimeString()}",${day.commits.length},"${commit.date.toLocaleTimeString()}","${msg}","${commit.hash.substring(0, 7)}"\n`;
					});
				});
			});

			const savePath = path.join(workspaceFolder.uri.fsPath, `工时统计_${new Date().toISOString().split('T')[0]}.csv`);
			fs.writeFileSync(savePath, '\ufeff' + csv);
			vscode.window.showInformationMessage(`已导出到: ${savePath}`);
		} catch (error) {
			vscode.window.showErrorMessage(`导出失败: ${error}`);
		}
	});

	context.subscriptions.push(showWorkHours, exportCSV);
}

function showWorkHourPanel(context: vscode.ExtensionContext, records: Map<string, WorkRecord>) {
	const panel = vscode.window.createWebviewPanel(
		'workHours',
		'工时统计',
		vscode.ViewColumn.One,
		{}
	);

	let html = '<html><head><style>body{font-family:Arial;padding:20px}table{border-collapse:collapse;width:100%;margin-bottom:20px}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#4CAF50;color:white}.commit-item{margin:5px 0;padding:5px;background:#f9f9f9;border-left:3px solid #4CAF50;font-size:12px}</style></head><body><h1>工时统计报告</h1>';

	records.forEach(record => {
		html += `<h2>${record.author} - 总计: ${record.totalHours.toFixed(2)} 小时</h2><table><tr><th>日期</th><th>工作时长</th><th>首次提交</th><th>最后提交</th><th>提交次数</th></tr>`;

		record.dailyWork.forEach(day => {
			html += `<tr><td>${day.day}</td><td>${day.hours.toFixed(2)} 小时</td><td>${day.firstCommit.toLocaleTimeString()}</td><td>${day.lastCommit.toLocaleTimeString()}</td><td>${day.commits.length}</td></tr>`;
		});

		html += '</table><h3>提交详情</h3>';

		record.dailyWork.forEach(day => {
			html += `<h4>${day.day}</h4>`;
			day.commits.forEach(commit => {
				html += `<div class="commit-item"><strong>${commit.date.toLocaleTimeString()}</strong> - ${commit.message} <small>(${commit.hash.substring(0, 7)})</small></div>`;
			});
		});
	});

	html += '</body></html>';
	panel.webview.html = html;
}

export function deactivate() {}
