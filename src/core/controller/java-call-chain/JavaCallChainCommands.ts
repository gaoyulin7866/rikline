import * as vscode from "vscode"
import * as path from "path"
import { JavaCallChainController } from "./JavaCallChainController"

export class JavaCallChainCommands {
	/**
	 * 注册所有Java调用链相关的命令
	 */
	public static registerCommands(context: vscode.ExtensionContext): void {
		// 注册命令
		context.subscriptions.push(
			// 导出调用链命令
			vscode.commands.registerCommand("javaCallChain.exportCallChain", async () => {
				await this.exportCallChain()
			}),
		)
	}

	/**
	 * 导出调用链
	 */
	private static async exportCallChain(): Promise<void> {
		try {
			// 显示进度条和loading状态
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "正在分析Java调用链...",
					cancellable: false,
				},
				async (progress) => {
					progress.report({ message: "正在获取控制器实例..." })
					const controller = JavaCallChainController.getInstance()

					progress.report({ message: "正在分析当前方法的调用链..." })
					const result = await controller.analyzeCallChainAtCursor()

					if (!result) {
						vscode.window.showWarningMessage("无法分析当前方法的调用链")
						return
					}

					progress.report({ message: "正在生成导出内容..." })
					// 生成导出内容
					const exportContent = this.generateExportContent(result)

					progress.report({ message: "正在创建新文档..." })
					// 创建新文档
					const document = await vscode.workspace.openTextDocument({
						content: exportContent,
						language: "markdown",
					})

					await vscode.window.showTextDocument(document)
					vscode.window.showInformationMessage("调用链已导出到新文档")
				},
			)
		} catch (error) {
			vscode.window.showErrorMessage(`生成调用链时出错: ${error}`)
		}
	}

	/**
	 * 生成导出内容
	 */
	private static generateExportContent(result: any): string {
		const timestamp = new Date().toLocaleString("zh-CN")

		let content = `# Java方法调用链分析报告\n\n`
		content += `**生成时间:** ${timestamp}\n`
		content += `**根方法:** ${result.root.className}.${result.root.methodName}\n`
		content += `**调用链深度:** ${result.depth}\n`
		content += `**总方法数:** ${result.totalMethods}\n\n`

		content += `## 调用链结构\n\n`
		content += this.generateTreeContent(result.root, 0)

		return content
	}

	/**
	 * 生成树形结构内容
	 */
	private static generateTreeContent(node: any, level: number): string {
		const indent = "  ".repeat(level)
		const isExternal = node.isExternal || node.filePath === "External"
		const externalMark = isExternal ? " (外部)" : ""

		// 生成可点击的文件路径链接
		let fileLink = `${node.filePath}:${node.lineNumber}`
		if (node.filePath && node.filePath !== "External") {
			try {
				fileLink = `file://${path.resolve(node.filePath).replace(/\\/g, "/")}#L${node.lineNumber}`
			} catch (error) {
				// 如果路径处理失败，回退到原始显示
				fileLink = `${node.filePath}:${node.lineNumber}`
			}
		}
		let content = `${indent}- **${node.methodName}** [${node.className}#${node.lineNumber}行](${fileLink})${externalMark}\n`
		if (node.children && node.children.length > 0) {
			for (const child of node.children) {
				content += this.generateTreeContent(child, level + 1)
			}
		}

		return content
	}
}
