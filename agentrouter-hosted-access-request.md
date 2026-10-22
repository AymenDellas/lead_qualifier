Subject: Supported server-side API access from Vercel

Hello AgentRouter team,

Could you confirm whether server-side requests from a Vercel-hosted application are supported, and enable the appropriate access or advise on the supported configuration?

Our Copy Studio uses the official Qwen Code client (0.24.6), with tools disabled, against https://agentrouter.org/v1 using model deepseek-v4-flash. The same API key, model, and client successfully complete requests on our local machine.

From our deployed Next.js application (Node.js 22, Vercel region cdg1), POST /v1/chat/completions instead returns HTTP 200 with Content-Type text/html and an Aliyun security-challenge page containing the aliyun_waf_aa marker. The client consequently reports a non-SSE response. This is not a JSON invalid-key response.

Application: https://compelos-three.vercel.app/

If hosted requests are permitted, please provide the supported API endpoint, any required account or client configuration, and the process for allowing Vercel requests with dynamic outbound IP addresses. We want to use the supported integration without bypassing the security gateway.

No API key is included in this request. Account details can be supplied privately through your official support process if needed.

Thank you.
