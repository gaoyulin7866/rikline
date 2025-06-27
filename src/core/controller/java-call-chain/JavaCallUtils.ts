import * as vscode from "vscode"
import * as fs from "fs"
import * as path from "path"

export class JavaCallUtils {
	/**
	 * 智能计算大括号，忽略字符串、字符字面量、注解、泛型参数和正则表达式中的大括号
	 */
	public static calculateBraceCount(line: string): { openBraces: number; closeBraces: number } {
		let openBraces = 0
		let closeBraces = 0
		let inString = false
		let inCharLiteral = false
		let inTextBlock = false
		let inAnnotation = false
		let inGeneric = false
		let inComment = false
		let inBlockComment = false
		let inRegex = false
		let escapeNext = false
		let stringDelimiter = '"'
		let annotationLevel = 0
		let genericLevel = 0

		for (let i = 0; i < line.length; i++) {
			const char = line[i]
			const nextChar = line[i + 1] || ""
			const nextNextChar = line[i + 2] || ""

			// 处理转义字符
			if (escapeNext) {
				escapeNext = false
				continue
			}

			if (char === "\\") {
				escapeNext = true
				continue
			}

			// 处理行注释
			if (
				!inString &&
				!inCharLiteral &&
				!inTextBlock &&
				!inAnnotation &&
				!inGeneric &&
				!inBlockComment &&
				!inRegex &&
				char === "/" &&
				nextChar === "/"
			) {
				inComment = true
				break // 行注释开始后，后面的内容都忽略
			}

			// 处理块注释开始
			if (
				!inString &&
				!inCharLiteral &&
				!inTextBlock &&
				!inAnnotation &&
				!inGeneric &&
				!inComment &&
				!inRegex &&
				char === "/" &&
				nextChar === "*"
			) {
				inBlockComment = true
				i++ // 跳过下一个字符
				continue
			}

			// 处理块注释结束
			if (inBlockComment && char === "*" && nextChar === "/") {
				inBlockComment = false
				i++ // 跳过下一个字符
				continue
			}

			// 如果在注释中，跳过所有字符
			if (inComment || inBlockComment) {
				continue
			}

			// 处理正则表达式开始
			if (
				!inString &&
				!inCharLiteral &&
				!inTextBlock &&
				!inAnnotation &&
				!inGeneric &&
				!inComment &&
				!inBlockComment &&
				!inRegex &&
				char === "/"
			) {
				// 检查是否是正则表达式开始
				const beforeChar = i > 0 ? line[i - 1] : ""
				const beforeBeforeChar = i > 1 ? line[i - 2] : ""

				// 正则表达式通常出现在以下情况：
				// 1. 方法调用中：.matches("/pattern/")
				// 2. 变量赋值：String pattern = "/pattern/"
				// 3. 条件判断：if (str.matches("/pattern/"))
				const isRegexStart = this.isRegexStart(line, i, beforeChar, beforeBeforeChar)

				if (isRegexStart) {
					inRegex = true
				}
				continue
			}

			// 处理正则表达式结束
			if (inRegex && char === "/") {
				// 检查是否是转义的斜杠
				if (escapeNext) {
					// 这是转义的斜杠，不是正则表达式结束
					continue
				}

				// 检查是否是正则表达式结束
				const nextNextNextChar = line[i + 3] || ""
				const afterSlash = line.substring(i + 1).trim()

				// 正则表达式结束的条件：
				// 1. 后面跟着标志字符：/pattern/g
				// 2. 后面跟着分号、逗号、括号等：/pattern/;
				// 3. 行尾
				const isRegexEnd = this.isRegexEnd(line, i, afterSlash, nextNextNextChar)

				if (isRegexEnd) {
					inRegex = false
				}
				continue
			}

			// 处理文本块 (Java 15+) - 修复逻辑
			if (
				!inString &&
				!inCharLiteral &&
				!inAnnotation &&
				!inGeneric &&
				!inRegex &&
				char === '"' &&
				nextChar === '"' &&
				nextNextChar === '"'
			) {
				// 检查是否是文本块的开始或结束
				// 在Java中，文本块必须在新行开始，并且结束的"""必须在行尾
				const beforeText = line.substring(0, i).trim()
				const afterText = line.substring(i + 3).trim()

				if (!inTextBlock && beforeText.length === 0) {
					// 文本块开始："""在行首
					inTextBlock = true
				} else if (inTextBlock && afterText.length === 0) {
					// 文本块结束："""在行尾
					inTextBlock = false
				}
				i += 2 // 跳过接下来的两个引号
				continue
			}

			// 处理字符串字面量 - 修复逻辑
			if (!inCharLiteral && !inTextBlock && !inAnnotation && !inGeneric && !inRegex && char === '"') {
				if (!inString) {
					inString = true
					stringDelimiter = char
				} else if (char === stringDelimiter) {
					inString = false
				}
				continue
			}

			// 处理字符字面量 - 修复逻辑
			if (!inString && !inTextBlock && !inAnnotation && !inGeneric && !inRegex && char === "'") {
				if (!inCharLiteral) {
					inCharLiteral = true
				} else {
					inCharLiteral = false
				}
				continue
			}

			// 处理注解
			if (!inString && !inCharLiteral && !inTextBlock && !inAnnotation && !inRegex && char === "@") {
				inAnnotation = true
				annotationLevel = 0
				continue
			}

			// 处理注解中的括号和大括号
			if (inAnnotation) {
				if (char === "(" || char === "{") {
					annotationLevel++
				} else if (char === ")" || char === "}") {
					annotationLevel--
					if (annotationLevel <= 0) {
						inAnnotation = false
					}
				}
				continue
			}

			// 处理泛型参数 - 改进检测逻辑
			if (!inString && !inCharLiteral && !inTextBlock && !inAnnotation && !inRegex && char === "<") {
				// 检查是否是泛型开始（前面是标识符或类名）
				const beforeChar = i > 0 ? line[i - 1] : ""
				const beforeBeforeChar = i > 1 ? line[i - 2] : ""
				const beforeBeforeBeforeChar = i > 2 ? line[i - 3] : ""

				// 更精确的泛型检测
				const isGenericStart = this.isGenericStart(line, i, beforeChar, beforeBeforeChar, beforeBeforeBeforeChar)

				if (isGenericStart) {
					inGeneric = true
					genericLevel = 0
				}
				continue
			}

			// 处理泛型中的括号
			if (inGeneric) {
				if (char === "<") {
					genericLevel++
				} else if (char === ">") {
					genericLevel--
					if (genericLevel <= 0) {
						inGeneric = false
					}
				}
				continue
			}

			// 只有在不在字符串、字符字面量、文本块、注解、泛型、正则表达式或注释中时才计算大括号
			if (
				!inString &&
				!inCharLiteral &&
				!inTextBlock &&
				!inAnnotation &&
				!inGeneric &&
				!inRegex &&
				!inComment &&
				!inBlockComment
			) {
				if (char === "{") {
					openBraces++
				} else if (char === "}") {
					closeBraces++
				}
			}
		}

		return { openBraces, closeBraces }
	}

	/**
	 * 判断是否是正则表达式开始
	 */
	private static isRegexStart(line: string, slashIndex: number, beforeChar: string, beforeBeforeChar: string): boolean {
		// 检查前面是否是注释开始
		if (beforeChar === "/" || beforeChar === "*") {
			return false
		}

		// 检查前面是否是行注释
		if (slashIndex > 0 && line[slashIndex - 1] === "/") {
			return false
		}

		// 检查前面是否是块注释结束
		if (slashIndex > 1 && line[slashIndex - 2] === "*" && line[slashIndex - 1] === "/") {
			return false
		}

		// 检查前面是否是字符串字面量
		const beforeText = line.substring(0, slashIndex)
		let quoteCount = 0
		for (let j = 0; j < beforeText.length; j++) {
			if (beforeText[j] === '"' && (j === 0 || beforeText[j - 1] !== "\\")) {
				quoteCount++
			}
		}
		if (quoteCount % 2 === 1) {
			return false // 在字符串内部
		}

		// 检查前面是否是字符字面量
		let singleQuoteCount = 0
		for (let j = 0; j < beforeText.length; j++) {
			if (beforeText[j] === "'" && (j === 0 || beforeText[j - 1] !== "\\")) {
				singleQuoteCount++
			}
		}
		if (singleQuoteCount % 2 === 1) {
			return false // 在字符字面量内部
		}

		// 1. 检查前面是否是方法调用的一部分（更精确的检测）
		if (beforeChar === ".") {
			// 向前查找方法名
			const beforeDot = line.substring(0, slashIndex - 1).trim()
			const methodNames = ["matches", "replaceAll", "replaceFirst", "split"]
			return methodNames.some((method) => beforeDot.endsWith(method))
		}

		// 2. 检查前面是否是赋值操作符（排除除法）
		if (beforeChar === "=" || beforeChar === "+" || beforeChar === "-" || beforeChar === "*") {
			return true
		}

		// 3. 检查前面是否是括号（方法参数）
		if (beforeChar === "(" || beforeChar === ",") {
			return true
		}

		// 4. 检查前面是否是关键字（更精确的检测）
		const words = beforeText.trim().split(/\s+/)
		const lastWord = words[words.length - 1]

		// 更精确的关键字检测
		const regexKeywords = ["matches", "replaceAll", "replaceFirst", "split"]
		if (regexKeywords.includes(lastWord)) {
			return true
		}

		// 检查 Pattern.compile 的情况
		if (lastWord === "compile" && words.length >= 2 && words[words.length - 2] === "Pattern") {
			return true
		}

		// 5. 检查前面是否是空格，然后是标识符（变量声明）
		if (beforeChar === " " && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(beforeBeforeChar)) {
			return true
		}

		// 6. 检查是否是 return 语句中的正则表达式
		if (beforeChar === " " && beforeBeforeChar === " ") {
			if (beforeText.trim().endsWith("return")) {
				return true
			}
		}

		// 7. 检查是否是 throw 语句中的正则表达式
		if (beforeText.trim().endsWith("throw")) {
			return true
		}

		return false
	}

	/**
	 * 判断是否是正则表达式结束
	 */
	private static isRegexEnd(line: string, slashIndex: number, afterSlash: string, nextNextNextChar: string): boolean {
		// 1. 后面跟着正则表达式标志字符（更精确的检测）
		if (/^[gimsux]*[^a-zA-Z0-9_]*/.test(afterSlash)) {
			// 确保标志字符后面跟着有效的结束字符
			const afterFlags = afterSlash.replace(/^[gimsux]*/, "")
			if (afterFlags.length === 0 || /^[;,)}\]\s+\+\-\*\/=<>!&|]/.test(afterFlags)) {
				return true
			}
		}

		// 2. 后面跟着常见的结束字符
		if (/^[;,)}\]\s]/.test(afterSlash)) {
			return true
		}

		// 3. 行尾
		if (afterSlash.length === 0) {
			return true
		}

		// 4. 后面跟着操作符
		if (/^[+\-*/=<>!&|]/.test(afterSlash)) {
			return true
		}

		// 5. 后面跟着字符串连接符
		if (afterSlash.startsWith(" + ") || afterSlash.startsWith(" +")) {
			return true
		}

		return false
	}

	/**
	 * 判断是否是泛型开始
	 */
	private static isGenericStart(
		line: string,
		slashIndex: number,
		beforeChar: string,
		beforeBeforeChar: string,
		beforeBeforeBeforeChar: string,
	): boolean {
		// 1. 检查前面是否是有效的标识符字符
		if (/[a-zA-Z0-9_>]/.test(beforeChar)) {
			return true
		}

		// 2. 检查前面是否有空格，然后是标识符
		if (beforeChar === " " && /[a-zA-Z0-9_]/.test(beforeBeforeChar)) {
			return true
		}

		// 3. 检查是否是方法返回类型
		if (beforeChar === " " && beforeBeforeChar === " ") {
			// 向前查找方法声明的开始
			const beforeText = line.substring(0, slashIndex).trim()
			const words = beforeText.split(/\s+/)

			// 检查是否是方法声明模式：修饰符 返回类型 方法名
			if (words.length >= 3) {
				const lastWord = words[words.length - 1]
				const secondLastWord = words[words.length - 2]

				// 检查是否是有效的Java标识符
				if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(lastWord) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(secondLastWord)) {
					return true
				}
			}
		}

		// 4. 检查是否是变量声明
		if (beforeChar === " " && beforeBeforeChar === "=") {
			return true
		}

		// 5. 检查是否是方法参数
		if (beforeChar === " " && beforeBeforeChar === ",") {
			return true
		}

		// 6. 检查是否是数组声明
		if (beforeChar === " " && beforeBeforeChar === "[") {
			return true
		}

		return false
	}
}
