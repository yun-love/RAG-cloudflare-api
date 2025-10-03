export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Expected POST method', { status: 405 });
    }

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

      const queryEmbeddingResponse = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [query] });
      const queryVector = queryEmbeddingResponse.data[0];

      // 【最终修复】在这里添加 returnMetadata: true 选项
      const searchResults = await env.VECTORIZE_INDEX.query(queryVector, {
        topK: 3,
        returnMetadata: true // <-- 就是这一行！
      });
      
      console.log("Vectorize Search Results:", JSON.stringify(searchResults, null, 2));

      const context = searchResults.matches
        .map(match => match.metadata ? match.metadata.text : '')
        .filter(text => text)
        .join("\n---\n");
        
      console.log("Constructed Context:", context);

      const prompt = `基于以下提供的上下文信息，请用中文简洁地回答用户的问题。
      如果上下文中没有足够的信息来回答，请明确说明“根据我所掌握的资料，我无法回答这个问题”，不要尝试编造答案。

      上下文:\n${context}\n\n问题: ${query}`;

      const modelResponse = await fetch(PROXY_API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${PROXY_API_KEY}`,
        },
        body: JSON.stringify({
          "model": "gemini-1.5-pro",
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