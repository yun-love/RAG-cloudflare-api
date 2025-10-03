/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    // 只接受 POST 请求
    if (request.method !== 'POST') {
      return new Response('Expected POST method', { status: 405 });
    }

    // 从环境变量中安全地获取自定义模型的 API 端点和密钥
    // 这些变量是通过 GitHub Actions secrets 注入的
    const API_ENDPOINT = env.CUSTOM_LLM_API_ENDPOINT;
    const API_KEY = env.CUSTOM_LLM_API_KEY;

    // 检查必要的配置是否存在
    if (!API_ENDPOINT) {
      console.error("CRITICAL: CUSTOM_LLM_API_ENDPOINT secret is not configured in the worker environment.");
      return new Response("Server configuration error: Model API endpoint is missing.", { status: 500 });
    }

    try {
      const { query } = await request.json();

      if (!query || typeof query !== 'string' || query.trim() === '') {
        return new Response(JSON.stringify({ error: "Query is required and must be a non-empty string." }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // --- RAG 流程开始 ---

      // 1. 将用户问题转换为向量嵌入
      // 使用 Cloudflare Workers AI 内置的模型
      const queryEmbeddingResponse = await env.AI.run(
        '@cf/baai/bge-base-en-v1.5',
        { text: [query] }
      );
      const queryVector = queryEmbeddingResponse.data[0];

      // 2. 在 Vectorize 向量数据库中搜索最相关的上下文
      // 'VECTORIZE_INDEX' 是在 wrangler.toml 中绑定的索引
      const searchResults = await env.VECTORIZE_INDEX.query(queryVector, { topK: 3 });
      
      // 从搜索结果的元数据中提取原始文本作为上下文
      const context = searchResults.matches
        .map(match => match.metadata ? match.metadata.text : '') // 安全地访问 metadata.text
        .filter(text => text) // 过滤掉空的文本
        .join("\n---\n");

      // 3. 构建发送给外部大语言模型 (LLM) 的最终提示 (Prompt)
      const prompt = `基于以下提供的上下文信息，请用中文简洁地回答用户的问题。
      如果上下文中没有足够的信息来回答，请明确说明“根据我所掌握的资料，我无法回答这个问题”，不要尝试编造答案。

      上下文:
      ${context}

      问题: ${query}`;

      // 4. 调用您自己的 AI 大模型 API 端点
      const modelResponse = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 根据您 API 的要求设置授权头
          // 常见的有 'Authorization': `Bearer ${API_KEY}` 或 'X-API-Key': API_KEY
          'Authorization': `Bearer ${API_KEY}`, 
        },
        // 【重要】请务必根据您模型的实际API文档来调整 body 的结构
        body: JSON.stringify({
          model: 'your-custom-model-name', // 示例模型名称
          messages: [{ role: 'user', content: prompt }],
          stream: false, // 如果您的模型支持流式输出，可以考虑开启
        }),
      });

      // 5. 检查来自大模型 API 的响应状态
      if (!modelResponse.ok) {
        const errorText = await modelResponse.text();
        console.error(`Custom LLM API Error: Status ${modelResponse.status} ${modelResponse.statusText}`, `Response Body: ${errorText}`);
        return new Response(`Error from upstream model API: ${errorText}`, { status: modelResponse.status });
      }

      // 6. 解析来自大模型 API 的 JSON 响应
      const responseData = await modelResponse.json();
      
      // 打印完整的响应数据到日志，方便调试
      console.log("Received data from LLM:", JSON.stringify(responseData, null, 2));
      
      // 7. 【重要】从响应数据中提取最终答案
      // 这个路径 (responseData.choices[0].message.content) 是 OpenAI-like API 的标准格式
      // 您必须根据您自己模型的实际返回结构来修改它！
      const answer = responseData.choices[0].message.content;

      if (!answer) {
        console.error("Failed to extract answer from LLM response. The expected data structure was not found.");
        return new Response("Worker error: Could not parse the answer from the model's response.", { status: 500 });
      }

      // 8. 将最终答案返回给客户端
      return new Response(JSON.stringify({ answer: answer }), {
          headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      // 捕获所有其他可能的运行时错误
      // 例如：请求的 body 不是有效的 JSON，网络连接问题，代码中的 bug 等
      console.error("Caught a top-level exception in chat-worker:", error);
      
      // 返回一个通用的服务器内部错误响应
      return new Response(JSON.stringify({ error: `Worker internal error: ${error.message}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};