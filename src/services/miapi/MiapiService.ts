import axios from "axios"

export class MiapiService {
	private readonly baseUrl: string
	constructor(baseUrl: string | undefined) {
		this.baseUrl = baseUrl ?? ""
	}

	async getApiDetailById(url: string) {
		const { projectID, apiID, apiProtocol } = this.extractMiapiParams(url)
		const response = await axios.post(
			`${this.baseUrl}/cline/getApiJsonById`,
			{
				projectID: projectID,
				apiID: apiID,
				apiProtocol: apiProtocol,
			},
			{
				headers: {
					"Content-Type": "application/json",
				},
			},
		)
		if (response.status !== 200) {
			return ""
		}
		if (response.data.code !== 0) {
			return ""
		}
		return response.data.data
	}

	private extractMiapiParams(text: string): { projectID?: string; apiID?: string; apiProtocol?: string } {
		const projectIDMatch = text.match(/projectID=(\d+)/)
		const apiIDMatch = text.match(/apiID=(\d+)/)
		const apiProtocolMatch = text.match(/apiProtocol=(\d+)/)

		return {
			projectID: projectIDMatch?.[1],
			apiID: apiIDMatch?.[1],
			apiProtocol: apiProtocolMatch?.[1],
		}
	}
}
