import * as vscode from "vscode"
import * as fs from "fs"
import * as path from "path"

export class JavaCallUtils {
	/**
	 * 智能计算大括号，忽略字符串、字符字面量、注解和泛型参数中的大括号
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

			// 处理文本块 (Java 15+) - 修复逻辑
			if (
				!inString &&
				!inCharLiteral &&
				!inAnnotation &&
				!inGeneric &&
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
			if (!inCharLiteral && !inTextBlock && !inAnnotation && !inGeneric && char === '"') {
				if (!inString) {
					inString = true
					stringDelimiter = char
				} else if (char === stringDelimiter) {
					inString = false
				}
				continue
			}

			// 处理字符字面量 - 修复逻辑
			if (!inString && !inTextBlock && !inAnnotation && !inGeneric && char === "'") {
				if (!inCharLiteral) {
					inCharLiteral = true
				} else {
					inCharLiteral = false
				}
				continue
			}

			// 处理注解
			if (!inString && !inCharLiteral && !inTextBlock && !inAnnotation && char === "@") {
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
			if (!inString && !inCharLiteral && !inTextBlock && !inAnnotation && char === "<") {
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

			// 只有在不在字符串、字符字面量、文本块、注解、泛型或注释中时才计算大括号
			if (!inString && !inCharLiteral && !inTextBlock && !inAnnotation && !inGeneric && !inComment && !inBlockComment) {
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
