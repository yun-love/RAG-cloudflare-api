export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Expected POST method', { status: 405 });
    }

    // 您的代理服务器的 URL 和 认证密钥
    const PROXY_API_ENDPOINT = env.CUSTOM_LLM_API_ENDPOINT;
    const PROXY_API_KEY = env.CUSTOM_LLM_API_KEY;

    if (!PROXY_API_ENDPOINT) {
      console.error("CRITICAL: CUSTOM_LLM_API_ENDPOINT (your proxy URL) secret is not configured.");
      return new Response("Server configuration error: Proxy API endpoint is missing.", { status: 500 });
    }

    try {
      const { query } = await request.json();

      if (!query || typeof query !== 'string' || query.trim() === '') {
        return new Response(JSON.stringify({ error: "Query is required." }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // --- RAG 流程 (这部分完全不变) ---
      const queryEmbeddingResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [query] });
      const queryVector = queryEmbeddingResponse.data[0];
      const searchResults = await env.VECTORIZE_INDEX.query(queryVector, { topK: 3 });
      const context = searchResults.matches
        .map(match => match.metadata ? match.metadata.text : '')
        .filter(text => text)
        .join("\n---\n");
      const prompt = `基于以下提供的上下文信息，请用中文简洁地回答用户的问题。
      如果上下文中没有足够的信息来回答，请明确说明“根据我所掌握的资料，我无法回答这个问题”，不要尝试编造答案。

      上下文:\n${context}\n\n问题: ${query}`;

      // 4. 【关键】调用您的代理服务器，使用标准的 OpenAI 请求格式
      const modelResponse = await fetch(PROXY_API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${PROXY_API_KEY}`, // 假设您的代理使用 Bearer Token
        },
        body: JSON.stringify({
          // 5. 【关键】指定您的代理所能识别的模型名称
          // 根据错误日志，这个名称很可能就是 "gemini-1.5-pro-latest"
          "model": "gemini-1.5-pro-latest", 
          "messages": [
            { "role": "user", "content": prompt }
          ],
          "stream": false
        }),
      });

      if (!modelResponse.ok) {
        const errorText = await modelResponse.text();
        console.error(`Proxy API Error: Status ${modelResponse.status}`, `Response: ${errorText}`);
        return new Response(`Error from upstream model API: ${errorText}`, { status: modelResponse.status });
      }

      const responseData = await modelResponse.json();
      
      // 6. 【关键】使用标准的 OpenAI 响应格式来提取答案
      const answer = responseData.choices[0].message.content;

      if (answer === undefined) {
        console.error("Failed to extract answer from proxy response.", JSON.stringify(responseData));
        return new Response("Worker error: Could not parse answer from proxy's response.", { status: 500 });
      }

      return new Response(JSON.stringify({ answer: answer }), {
          headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      console.error("Caught a top-level exception in chat-worker:", error);
      return new Response(JSON.stringify({ error: `Worker internal error: ${error.message}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};