import * as vscode from "vscode"
import * as fs from "fs"
import * as path from "path"
import { JavaCallUtils } from "./JavaCallUtils"

export interface CallChainNode {
	methodName: string
	className: string
	filePath: string
	lineNumber: number
	children: CallChainNode[]
	isExternal?: boolean
	parameters?: string[]
	returnType?: string
}

export interface CallChainResult {
	root: CallChainNode
	depth: number
	totalMethods: number
}

export class JavaCallChainController {
	private static instance: JavaCallChainController
	private visitedMethods: Set<string> = new Set()
	private maxDepth: number = 10 // 防止无限递归

	public static getInstance(): JavaCallChainController {
		if (!JavaCallChainController.instance) {
			JavaCallChainController.instance = new JavaCallChainController()
		}
		return JavaCallChainController.instance
	}

	/**
	 * 分析当前光标位置的方法向上调用链（查找调用当前方法的方法）
	 * 会在整个工作区的所有Java文件中搜索调用当前方法的方法
	 */
	public async analyzeCallChain(): Promise<CallChainResult | null> {
		const editor = vscode.window.activeTextEditor
		if (!editor || editor.document.languageId !== "java") {
			vscode.window.showWarningMessage("请在Java文件中使用此功能")
			return null
		}

		const position = editor.selection.active
		const document = editor.document
		const text = document.getText()

		// 重置访问记录
		this.visitedMethods.clear()

		// 获取当前方法信息
		const currentMethod = this.findMethodAtPosition(text, position.line)
		if (!currentMethod) {
			vscode.window.showWarningMessage("无法找到当前方法")
			return null
		}

		// 构建向上调用链
		const callChain = await this.buildUpwardCallChain(currentMethod, document.fileName, text, 0)

		return {
			root: callChain,
			depth: this.calculateDepth(callChain),
			totalMethods: this.countTotalMethods(callChain),
		}
	}

	/**
	 * 查找指定位置的方法
	 */
	private findMethodAtPosition(
		text: string,
		lineNumber: number,
	): { name: string; className: string; parameters?: string[]; returnType?: string } | null {
		const lines = text.split("\n")

		// 改进的类定义正则表达式 - 支持更多修饰符和格式
		const classRegex = /^\s*(?:public\s+)?(?:abstract\s+)?(?:final\s+)?(?:strictfp\s+)?class\s+(\w+)/

		let currentClass = ""
		let braceCount = 0
		let inClass = false
		let classStartLine = -1

		// 查找当前类名和确定是否在类内部
		for (let i = 0; i <= lineNumber; i++) {
			const line = lines[i]
			const trimmedLine = line.trim()

			// 跳过空行和注释行
			if (!trimmedLine || trimmedLine.startsWith("//") || trimmedLine.startsWith("/*") || trimmedLine.startsWith("*")) {
				continue
			}

			if (!inClass) {
				const classMatch = line.match(classRegex)
				if (classMatch) {
					currentClass = classMatch[1]
					inClass = true
					classStartLine = i
					braceCount = 0
				}
			}

			if (inClass) {
				// 使用智能大括号计数
				const braceResult = JavaCallUtils.calculateBraceCount(line)
				braceCount += braceResult.openBraces
				braceCount -= braceResult.closeBraces

				// 只有当大括号计数为0且不在类开始行时才离开类作用域
				if (braceCount <= 0 && i >= classStartLine) {
					inClass = false
					currentClass = ""
				}
			}
		}

		// 查找当前方法 - 支持多行方法声明
		for (let i = lineNumber; i >= 0; i--) {
			const line = lines[i]
			const trimmedLine = line.trim()

			// 跳过空行和注释行
			if (!trimmedLine || trimmedLine.startsWith("//") || trimmedLine.startsWith("/*") || trimmedLine.startsWith("*")) {
				continue
			}

			// 检查是否是方法声明的开始
			const methodStartRegex = /^\s*(?:public|private|protected|static|\s)*\s*([\w\<\>\[\]]+)\s+(\w+)\s*\(/
			const methodMatch = line.match(methodStartRegex)

			if (methodMatch) {
				// 收集完整的方法声明
				let methodBuffer = line
				let methodEndLine = i

				// 如果当前行没有方法体开始，继续向后查找
				if (!line.includes("{")) {
					for (let j = i + 1; j < lines.length; j++) {
						const nextLine = lines[j]
						methodBuffer += " " + nextLine
						methodEndLine = j

						if (nextLine.includes("{")) {
							break
						}
					}
				}

				// 解析方法声明
				const methodInfo = this.parseMethodDeclaration(methodBuffer)
				if (methodInfo) {
					return {
						name: methodInfo.name,
						className: currentClass,
						returnType: methodInfo.returnType,
						parameters: methodInfo.parameters,
					}
				}
			}
		}

		return null
	}

	/**
	 * 解析方法声明字符串
	 */
	private parseMethodDeclaration(methodBuffer: string): { name: string; returnType: string; parameters: string[] } | null {
		// 改进的方法声明解析正则表达式
		const methodRegex = /^\s*(?:public|private|protected|static|\s)*\s*([\w\<\>\[\]]+)\s+(\w+)\s*\(([^)]*)\)/
		const match = methodBuffer.match(methodRegex)

		if (match) {
			const returnType = match[1].trim()
			const methodName = match[2]
			const parametersStr = match[3].trim()

			// 解析参数列表
			let parameters: string[] = []
			if (parametersStr.length > 0) {
				// 处理多行参数列表
				const cleanParamsStr = parametersStr.replace(/\s+/g, " ").trim()
				parameters = cleanParamsStr
					.split(",")
					.map((p) => p.trim())
					.filter((p) => p.length > 0)
			}

			return {
				name: methodName,
				returnType: returnType,
				parameters: parameters,
			}
		}

		return null
	}

	/**
	 * 构建向上方法调用链（查找调用当前方法的方法）
	 */
	private async buildUpwardCallChain(
		method: { name: string; className: string; parameters?: string[]; returnType?: string },
		filePath: string,
		text: string,
		depth: number,
	): Promise<CallChainNode> {
		// 防止无限递归
		if (depth >= this.maxDepth) {
			return {
				methodName: method.name,
				className: method.className,
				filePath: filePath,
				lineNumber: this.findMethodLine(text, method.name),
				children: [],
				isExternal: true,
				parameters: method.parameters,
				returnType: method.returnType,
			}
		}

		// 创建方法唯一标识符
		const methodKey = `${filePath}:${method.className}.${method.name}`
		if (this.visitedMethods.has(methodKey)) {
			return {
				methodName: method.name,
				className: method.className,
				filePath: filePath,
				lineNumber: this.findMethodLine(text, method.name),
				children: [],
				isExternal: true,
				parameters: method.parameters,
				returnType: method.returnType,
			}
		}
		this.visitedMethods.add(methodKey)

		const root: CallChainNode = {
			methodName: method.name,
			className: method.className,
			filePath: filePath,
			lineNumber: this.findMethodLine(text, method.name),
			children: [],
			parameters: method.parameters,
			returnType: method.returnType,
		}

		// 查找调用当前方法的方法
		const callingMethods = await this.findCallingMethods(method)

		for (const callingMethod of callingMethods) {
			const childNode = await this.buildUpwardCallChain(
				{
					name: callingMethod.name,
					className: callingMethod.className,
					parameters: callingMethod.parameters,
					returnType: callingMethod.returnType,
				},
				callingMethod.filePath,
				fs.readFileSync(callingMethod.filePath, "utf8"),
				depth + 1,
			)
			root.children.push(childNode)
		}

		return root
	}

	/**
	 * 查找调用指定方法的方法
	 */
	private async findCallingMethods(targetMethod: {
		name: string
		className: string
		parameters?: string[]
		returnType?: string
	}): Promise<
		Array<{ name: string; className: string; filePath: string; line: number; parameters?: string[]; returnType?: string }>
	> {
		const callingMethods: Array<{
			name: string
			className: string
			filePath: string
			line: number
			parameters?: string[]
			returnType?: string
		}> = []

		// 在整个工作区中查找调用目标方法的方法
		const workspaceCallers = await this.findCallingMethodsInWorkspace(targetMethod)
		callingMethods.push(...workspaceCallers)

		return callingMethods
	}

	/**
	 * 在指定文件中查找调用目标方法的方法
	 */
	private findCallingMethodsInFile(
		filePath: string,
		targetMethod: { name: string; className: string; parameters?: string[]; returnType?: string },
	): Array<{ name: string; className: string; filePath: string; line: number; parameters?: string[]; returnType?: string }> {
		const callingMethods: Array<{
			name: string
			className: string
			filePath: string
			line: number
			parameters?: string[]
			returnType?: string
		}> = []

		try {
			const content = fs.readFileSync(filePath, "utf8")
			const lines = content.split("\n")

			// 查找所有方法定义
			const methodDefinitions = this.findAllMethodDefinitions(content)

			// 检查每个方法是否调用了目标方法
			for (const methodDef of methodDefinitions) {
				// 跳过目标方法本身
				if (methodDef.name === targetMethod.name && methodDef.className === targetMethod.className) {
					continue
				}

				const methodRange = this.findMethodRange(content, methodDef.name)
				if (methodRange) {
					// 检查方法体中是否调用了目标方法
					const methodBody = lines.slice(methodRange.start, methodRange.end + 1).join("\n")

					if (this.containsMethodCall(methodBody, targetMethod)) {
						console.log(
							`找到调用: ${methodDef.className}.${methodDef.name} 调用了 ${targetMethod.className}.${targetMethod.name}`,
						)
						callingMethods.push({
							name: methodDef.name,
							className: methodDef.className,
							filePath: filePath,
							line: methodDef.line,
							parameters: methodDef.parameters,
							returnType: methodDef.returnType,
						})
					}
				}
			}
		} catch (error) {
			console.error(`Error reading file ${filePath}:`, error)
		}

		return callingMethods
	}

	/**
	 * 在整个工作区中查找调用目标方法的方法
	 */
	private async findCallingMethodsInWorkspace(targetMethod: {
		name: string
		className: string
		parameters?: string[]
		returnType?: string
	}): Promise<
		Array<{ name: string; className: string; filePath: string; line: number; parameters?: string[]; returnType?: string }>
	> {
		const callingMethods: Array<{
			name: string
			className: string
			filePath: string
			line: number
			parameters?: string[]
			returnType?: string
		}> = []
		const javaFiles = await vscode.workspace.findFiles("**/*.java")

		console.log(`搜索调用 ${targetMethod.className}.${targetMethod.name} 的方法，共检查 ${javaFiles.length} 个Java文件`)

		for (const file of javaFiles) {
			const fileCallers = this.findCallingMethodsInFile(file.fsPath, targetMethod)
			if (fileCallers.length > 0) {
				console.log(`在文件 ${file.fsPath} 中找到 ${fileCallers.length} 个调用者`)
			}
			callingMethods.push(...fileCallers)
		}

		console.log(`总共找到 ${callingMethods.length} 个调用 ${targetMethod.className}.${targetMethod.name} 的方法`)
		return callingMethods
	}

	/**
	 * 查找文件中所有方法定义
	 */
	private findAllMethodDefinitions(
		text: string,
	): Array<{ name: string; className: string; line: number; parameters?: string[]; returnType?: string }> {
		const methodDefinitions: Array<{
			name: string
			className: string
			line: number
			parameters?: string[]
			returnType?: string
		}> = []
		const lines = text.split("\n")

		// 改进的类定义正则表达式 - 支持更多修饰符和格式
		const classRegex = /^\s*(?:public\s+)?(?:abstract\s+)?(?:final\s+)?(?:strictfp\s+)?class\s+(\w+)/

		let currentClass = ""
		let braceCount = 0
		let inClass = false
		let classStartLine = -1
		let methodBuffer = ""
		let methodStartLine = -1
		let inMethodDeclaration = false

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const trimmedLine = line.trim()

			// 跳过空行和注释行
			if (!trimmedLine || trimmedLine.startsWith("//") || trimmedLine.startsWith("/*") || trimmedLine.startsWith("*")) {
				continue
			}

			// 检测类开始
			if (!inClass) {
				const classMatch = line.match(classRegex)
				if (classMatch) {
					currentClass = classMatch[1]
					inClass = true
					classStartLine = i
					braceCount = 0
					console.log(`找到类: ${currentClass} 在行 ${i + 1}`)
				}
			}

			// 如果在类内部，计算大括号
			if (inClass) {
				// 使用智能大括号计数
				const braceResult = JavaCallUtils.calculateBraceCount(line)
				braceCount += braceResult.openBraces
				braceCount -= braceResult.closeBraces

				// 只有当大括号计数为0且不在类开始行时才离开类作用域
				if (braceCount <= 0 && i >= classStartLine) {
					inClass = false
					currentClass = ""
					console.log(`离开类作用域在行 ${i + 1}`)
				}
			}

			// 检测方法声明开始
			if (inClass && !inMethodDeclaration) {
				// 改进的方法声明检测 - 支持多行声明
				const methodStartRegex = /^\s*(?:public|private|protected|static|\s)*\s*([\w\<\>\[\]]+)\s+(\w+)\s*\(/
				const methodMatch = line.match(methodStartRegex)

				if (methodMatch) {
					inMethodDeclaration = true
					methodStartLine = i
					methodBuffer = line

					// 检查是否在同一行完成方法声明
					if (line.includes("{")) {
						// 方法声明在同一行完成
						this.processMethodDeclaration(methodBuffer, methodStartLine, currentClass, methodDefinitions)
						inMethodDeclaration = false
						methodBuffer = ""
						methodStartLine = -1
						i += this.isMethodDeclarationEnd(lines, i)
					}
				}
			} else if (inMethodDeclaration) {
				// 继续收集方法声明
				methodBuffer += " " + line

				// 检查是否找到方法体的开始
				if (line.includes("{")) {
					i += this.isMethodDeclarationEnd(lines, i)
					// 方法声明完成
					this.processMethodDeclaration(methodBuffer, methodStartLine, currentClass, methodDefinitions)
					inMethodDeclaration = false
					methodBuffer = ""
					methodStartLine = -1
				}
			}
		}

		console.log(`总共找到 ${methodDefinitions.length} 个方法定义`)
		return methodDefinitions
	}

	/**
	 * 判断方法声明是否结束
	 * @param lines 代码行数组
	 * @param startLine 方法声明开始行
	 * @returns 方法声明结束行数
	 */
	private isMethodDeclarationEnd(lines: Array<string>, startLine: number): number {
		let braceCount = 0
		for (let i = startLine; i < lines.length; i++) {
			const line = lines[i]
			const braceResult = JavaCallUtils.calculateBraceCount(line)
			braceCount += braceResult.closeBraces
			braceCount -= braceResult.openBraces
			if (braceCount === 0) {
				return i - startLine
			}
		}
		return 0
	}

	/**
	 * 处理方法声明字符串，提取方法信息
	 */
	private processMethodDeclaration(
		methodBuffer: string,
		lineNumber: number,
		className: string,
		methodDefinitions: Array<{ name: string; className: string; line: number; parameters?: string[]; returnType?: string }>,
	) {
		// 改进的方法声明解析正则表达式
		const methodRegex = /^\s*(?:public|private|protected|static|\s)*\s*([\w\<\>\[\]]+)\s+(\w+)\s*\(([^)]*)\)/
		const match = methodBuffer.match(methodRegex)

		if (match) {
			const returnType = match[1].trim()
			const methodName = match[2]
			const parametersStr = match[3].trim()

			// 解析参数列表
			let parameters: string[] = []
			if (parametersStr.length > 0) {
				// 处理多行参数列表
				const cleanParamsStr = parametersStr.replace(/\s+/g, " ").trim()
				parameters = cleanParamsStr
					.split(",")
					.map((p) => p.trim())
					.filter((p) => p.length > 0)
			}

			console.log(`找到方法: ${returnType} ${methodName}(${parameters.join(", ")}) 在行 ${lineNumber + 1}`)

			methodDefinitions.push({
				name: methodName,
				className: className,
				line: lineNumber + 1,
				returnType: returnType,
				parameters: parameters,
			})
		}
	}

	/**
	 * 检查方法体中是否包含对目标方法的调用
	 */
	private containsMethodCall(
		methodBody: string,
		targetMethod: { name: string; className: string; parameters?: string[]; returnType?: string },
	): boolean {
		const lines = methodBody.split("\n")

		for (const line of lines) {
			// 跳过注释行
			if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) {
				continue
			}

			// 检查各种类型的方法调用
			// 1. 对象方法调用: obj.method()
			const objectMethodRegex = new RegExp(`\\b\\w+\\.${targetMethod.name}\\s*\\(`, "g")
			if (objectMethodRegex.exec(line)) {
				return true
			}

			// 2. 静态方法调用: Class.method()
			const staticMethodRegex = new RegExp(`\\b${targetMethod.className}\\.${targetMethod.name}\\s*\\(`, "g")
			if (staticMethodRegex.exec(line)) {
				return true
			}

			// 3. 简单方法调用: method() (在同一类中)
			const simpleCallRegex = new RegExp(`\\b${targetMethod.name}\\s*\\(`, "g")
			if (simpleCallRegex.exec(line)) {
				return true
			}

			// 4. 构造函数调用: new Class()
			if (targetMethod.name === targetMethod.className) {
				const constructorRegex = new RegExp(`\\bnew\\s+${targetMethod.className}\\s*\\(`, "g")
				if (constructorRegex.exec(line)) {
					return true
				}
			}

			// 5. 通过变量调用的方法: variable.method()
			const variableMethodRegex = new RegExp(`\\b[a-zA-Z_][a-zA-Z0-9_]*\\.${targetMethod.name}\\s*\\(`, "g")
			if (variableMethodRegex.exec(line)) {
				return true
			}

			// 6. 链式调用: obj.method1().method2().targetMethod()
			const chainedMethodRegex = new RegExp(`\\.${targetMethod.name}\\s*\\(`, "g")
			if (chainedMethodRegex.exec(line)) {
				return true
			}

			// 7. 通过this调用的方法: this.method()
			const thisMethodRegex = new RegExp(`\\bthis\\.${targetMethod.name}\\s*\\(`, "g")
			if (thisMethodRegex.exec(line)) {
				return true
			}

			// 8. 通过super调用的方法: super.method()
			const superMethodRegex = new RegExp(`\\bsuper\\.${targetMethod.name}\\s*\\(`, "g")
			if (superMethodRegex.exec(line)) {
				return true
			}
		}

		return false
	}

	/**
	 * 构建方法调用链
	 */
	private async buildCallChain(
		method: { name: string; className: string; parameters?: string[]; returnType?: string },
		filePath: string,
		text: string,
		depth: number,
	): Promise<CallChainNode> {
		// 防止无限递归
		if (depth >= this.maxDepth) {
			return {
				methodName: method.name,
				className: method.className,
				filePath: filePath,
				lineNumber: this.findMethodLine(text, method.name),
				children: [],
				isExternal: true,
				parameters: method.parameters,
				returnType: method.returnType,
			}
		}

		// 创建方法唯一标识符
		const methodKey = `${filePath}:${method.className}.${method.name}`
		if (this.visitedMethods.has(methodKey)) {
			return {
				methodName: method.name,
				className: method.className,
				filePath: filePath,
				lineNumber: this.findMethodLine(text, method.name),
				children: [],
				isExternal: true,
				parameters: method.parameters,
				returnType: method.returnType,
			}
		}
		this.visitedMethods.add(methodKey)

		const root: CallChainNode = {
			methodName: method.name,
			className: method.className,
			filePath: filePath,
			lineNumber: this.findMethodLine(text, method.name),
			children: [],
			parameters: method.parameters,
			returnType: method.returnType,
		}

		// 查找方法调用
		const methodCalls = this.findMethodCalls(text, method.name)

		for (const call of methodCalls) {
			const childNode = await this.resolveMethodCall(call, filePath, depth + 1)
			if (childNode) {
				root.children.push(childNode)
			}
		}

		return root
	}

	/**
	 * 查找方法定义行号
	 */
	private findMethodLine(text: string, methodName: string): number {
		const lines = text.split("\n")

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const trimmedLine = line.trim()

			// 跳过空行和注释行
			if (!trimmedLine || trimmedLine.startsWith("//") || trimmedLine.startsWith("/*") || trimmedLine.startsWith("*")) {
				continue
			}

			// 检查是否是方法声明的开始
			const methodStartRegex = new RegExp(
				`^\\s*(?:public|private|protected|static|\\s)*\\s*[\\w\\<\\>\\[\\]]+\\s+${methodName}\\s*\\(`,
			)
			if (methodStartRegex.test(line)) {
				return i + 1
			}
		}

		return 1
	}

	/**
	 * 查找方法中的方法调用
	 */
	private findMethodCalls(
		text: string,
		methodName: string,
	): Array<{ name: string; className?: string; line: number; parameters?: string[] }> {
		const calls: Array<{ name: string; className?: string; line: number; parameters?: string[] }> = []
		const lines = text.split("\n")

		// 找到方法开始和结束位置
		const methodRange = this.findMethodRange(text, methodName)
		if (!methodRange) {
			return calls
		}

		// 在方法范围内查找方法调用
		for (let i = methodRange.start; i <= methodRange.end; i++) {
			const line = lines[i]

			// 跳过注释行
			if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) {
				continue
			}

			// 查找各种类型的方法调用
			this.extractMethodCallsFromLine(line, i + 1, calls)
		}

		return calls
	}

	/**
	 * 从单行代码中提取方法调用
	 */
	private extractMethodCallsFromLine(
		line: string,
		lineNumber: number,
		calls: Array<{ name: string; className?: string; line: number; parameters?: string[] }>,
	) {
		// 1. 对象方法调用: obj.method()
		const objectMethodRegex = /(\w+)\.(\w+)\s*\(/g
		let match
		while ((match = objectMethodRegex.exec(line)) !== null) {
			const objectName = match[1]
			const methodName = match[2]

			// 排除常见的关键字
			if (
				!["if", "for", "while", "switch", "catch", "try", "return", "new", "super", "this", "null"].includes(objectName)
			) {
				calls.push({
					name: methodName,
					className: objectName,
					line: lineNumber,
				})
			}
		}

		// 2. 静态方法调用: Class.method()
		const staticMethodRegex = /([A-Z]\w*)\.(\w+)\s*\(/g
		while ((match = staticMethodRegex.exec(line)) !== null) {
			const className = match[1]
			const methodName = match[2]
			calls.push({
				name: methodName,
				className: className,
				line: lineNumber,
			})
		}

		// 3. 简单方法调用: method()
		const simpleCallRegex = /(\w+)\s*\(/g
		while ((match = simpleCallRegex.exec(line)) !== null) {
			const methodName = match[1]
			// 排除关键字和常见方法
			if (
				![
					"if",
					"for",
					"while",
					"switch",
					"catch",
					"try",
					"return",
					"new",
					"super",
					"this",
					"null",
					"true",
					"false",
				].includes(methodName)
			) {
				calls.push({
					name: methodName,
					line: lineNumber,
				})
			}
		}

		// 4. 构造函数调用: new Class()
		const constructorRegex = /new\s+([A-Z]\w*)\s*\(/g
		while ((match = constructorRegex.exec(line)) !== null) {
			const className = match[1]
			calls.push({
				name: className, // 构造函数名就是类名
				className: className,
				line: lineNumber,
			})
		}
	}

	/**
	 * 查找方法范围
	 */
	private findMethodRange(text: string, methodName: string): { start: number; end: number } | null {
		const lines = text.split("\n")

		let methodStart = -1
		let methodBuffer = ""
		let inMethodDeclaration = false

		// 查找方法开始位置
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const trimmedLine = line.trim()

			// 跳过空行和注释行
			if (!trimmedLine || trimmedLine.startsWith("//") || trimmedLine.startsWith("/*") || trimmedLine.startsWith("*")) {
				continue
			}

			// 检查是否是方法声明的开始
			const methodStartRegex = new RegExp(
				`^\\s*(?:public|private|protected|static|\\s)*\\s*[\\w\\<\\>\\[\\]]+\\s+${methodName}\\s*\\(`,
			)

			if (!inMethodDeclaration && methodStartRegex.test(line)) {
				methodStart = i
				inMethodDeclaration = true
				methodBuffer = line

				// 检查是否在同一行完成方法声明
				if (line.includes("{")) {
					break
				}
			} else if (inMethodDeclaration) {
				// 继续收集方法声明
				methodBuffer += " " + line

				// 检查是否找到方法体的开始
				if (line.includes("{")) {
					break
				}
			}
		}

		if (methodStart === -1) {
			return null
		}

		// 查找方法结束位置
		let braceCount = 0
		let inMethod = false

		for (let i = methodStart; i < lines.length; i++) {
			const line = lines[i]

			if (!inMethod && line.includes("{")) {
				inMethod = true
			}

			if (inMethod) {
				// 使用智能大括号计数
				const braceResult = JavaCallUtils.calculateBraceCount(line)
				braceCount += braceResult.openBraces
				braceCount -= braceResult.closeBraces

				if (braceCount === 0) {
					return { start: methodStart, end: i }
				}
			}
		}

		return { start: methodStart, end: lines.length - 1 }
	}

	/**
	 * 解析方法调用
	 */
	private async resolveMethodCall(
		call: { name: string; className?: string; line: number; parameters?: string[] },
		currentFilePath: string,
		depth: number,
	): Promise<CallChainNode | null> {
		// 如果有类名，尝试在当前文件中查找
		if (call.className) {
			const methodInfo = await this.findMethodInFile(currentFilePath, call.name, call.className)
			if (methodInfo) {
				const childNode = await this.buildCallChain(
					{
						name: call.name,
						className: call.className,
						parameters: methodInfo.parameters,
						returnType: methodInfo.returnType,
					},
					currentFilePath,
					fs.readFileSync(currentFilePath, "utf8"),
					depth,
				)
				return childNode
			}
		}

		// 尝试在工作区中查找方法定义
		const workspaceMethod = await this.findMethodInWorkspace(call.name, call.className)
		if (workspaceMethod) {
			const fileContent = fs.readFileSync(workspaceMethod.filePath, "utf8")
			const childNode = await this.buildCallChain(
				{
					name: call.name,
					className: workspaceMethod.className,
					parameters: workspaceMethod.parameters,
					returnType: workspaceMethod.returnType,
				},
				workspaceMethod.filePath,
				fileContent,
				depth,
			)
			return childNode
		}

		// 如果找不到，创建外部方法节点
		return {
			methodName: call.name,
			className: call.className || "Unknown",
			filePath: "External",
			lineNumber: call.line,
			children: [],
			isExternal: true,
			parameters: call.parameters,
		}
	}

	/**
	 * 在文件中查找方法
	 */
	private async findMethodInFile(
		filePath: string,
		methodName: string,
		className?: string,
	): Promise<{ line: number; className: string; parameters?: string[]; returnType?: string } | null> {
		try {
			const content = fs.readFileSync(filePath, "utf8")
			const lines = content.split("\n")

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]
				const trimmedLine = line.trim()

				// 跳过空行和注释行
				if (!trimmedLine || trimmedLine.startsWith("//") || trimmedLine.startsWith("/*") || trimmedLine.startsWith("*")) {
					continue
				}

				// 检查是否是方法声明的开始
				const methodStartRegex = new RegExp(
					`^\\s*(?:public|private|protected|static|\\s)*\\s*([\\w\\<\\>\\[\\]]+)\\s+${methodName}\\s*\\(`,
				)
				const match = line.match(methodStartRegex)

				if (match) {
					// 收集完整的方法声明
					let methodBuffer = line

					// 如果当前行没有方法体开始，继续向后查找
					if (!line.includes("{")) {
						for (let j = i + 1; j < lines.length; j++) {
							const nextLine = lines[j]
							methodBuffer += " " + nextLine

							if (nextLine.includes("{")) {
								break
							}
						}
					}

					// 解析方法声明
					const methodInfo = this.parseMethodDeclaration(methodBuffer)
					if (methodInfo) {
						// 查找类名
						let foundClassName = className || "Unknown"
						for (let j = i; j >= 0; j--) {
							const classMatch = lines[j].match(
								/^\s*(?:public\s+)?(?:abstract\s+)?(?:final\s+)?(?:strictfp\s+)?class\s+(\w+)/,
							)
							if (classMatch) {
								foundClassName = classMatch[1]
								break
							}
						}

						return {
							line: i + 1,
							className: foundClassName,
							parameters: methodInfo.parameters,
							returnType: methodInfo.returnType,
						}
					}
				}
			}
		} catch (error) {
			console.error(`Error reading file ${filePath}:`, error)
		}

		return null
	}

	/**
	 * 在工作区中查找方法
	 */
	private async findMethodInWorkspace(
		methodName: string,
		className?: string,
	): Promise<{ filePath: string; line: number; className: string; parameters?: string[]; returnType?: string } | null> {
		const javaFiles = await vscode.workspace.findFiles("**/*.java")

		for (const file of javaFiles) {
			const methodInfo = await this.findMethodInFile(file.fsPath, methodName, className)
			if (methodInfo) {
				return {
					filePath: file.fsPath,
					line: methodInfo.line,
					className: methodInfo.className,
					parameters: methodInfo.parameters,
					returnType: methodInfo.returnType,
				}
			}
		}

		return null
	}

	/**
	 * 计算调用链深度
	 */
	private calculateDepth(node: CallChainNode): number {
		if (node.children.length === 0) {
			return 1
		}

		let maxDepth = 0
		for (const child of node.children) {
			const childDepth = this.calculateDepth(child)
			maxDepth = Math.max(maxDepth, childDepth)
		}

		return maxDepth + 1
	}

	/**
	 * 计算总方法数
	 */
	private countTotalMethods(node: CallChainNode): number {
		let count = 1
		for (const child of node.children) {
			count += this.countTotalMethods(child)
		}
		return count
	}
}
