export default {
  async fetch(request, env) {
    // 1. 从环境变量中获取自定义模型的 API 端点和密钥
    const API_ENDPOINT = env.CUSTOM_LLM_API_ENDPOINT;
    const API_KEY = env.CUSTOM_LLM_API_KEY;

    if (!API_ENDPOINT) {
        return new Response("CUSTOM_LLM_API_ENDPOINT is not configured.", { status: 500 });
    }

    const { query } = await request.json();
    if (!query) {
      return new Response("Query is required", { status: 400 });
    }

    // 2. 将用户问题转换为向量 (此部分不变)
    const queryEmbedding = await env.AI.run(
      '@cf/baai/bge-base-en-v1.5',
      { text: [query] }
    );
    const queryVector = queryEmbedding.data[0];

    // 3. 在 Vectorize 中搜索最相关的上下文 (此部分不变)
    const searchResults = await env.VECTORIZE_INDEX.query(queryVector, { topK: 3 });
    const context = searchResults.matches
      .map(match => match.metadata.text)
      .join("\n---\n");

    const prompt = `基于以下上下文信息，请用中文回答问题。
    如果上下文没有提供足够的信息，请说“根据我所掌握的资料，我无法回答这个问题”。

    上下文:
    ${context}

    问题: ${query}`;

    // 4. 【关键变更】调用您自己的 AI 大模型 API 端点
    const modelResponse = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 根据您 API 的要求设置授权头，常见的有 'Bearer' 或 'X-API-Key'
        'Authorization': `Bearer ${API_KEY}`,
      },
      // 【重要】请根据您模型的实际API文档来调整 body 的结构
      body: JSON.stringify({
        // 这里的结构完全取决于您的模型API
        // 可能是 'prompt', 'messages', 'inputs' 等
        // 下面是一个通用示例：
        model: 'your-custom-model-name',
        messages: [{ role: 'user', content: prompt }],
        stream: false, // 如果您的模型支持流式输出，可以考虑开启
      }),
    });
    
    if (!modelResponse.ok) {
        const errorText = await modelResponse.text();
        return new Response(`Error from custom LLM API: ${errorText}`, { status: modelResponse.status });
    }

    // 5. 【关键变更】解析您模型返回的响应
    const responseData = await modelResponse.json();
    
    // 【重要】同样，请根据您模型的API文档来修改解析响应数据的代码
    // 答案可能在 responseData.choices[0].message.content
    // 或 responseData.generated_text
    // 或其他地方
    const answer = responseData.choices[0].message.content; // 这是一个示例，请务必修改

    return new Response(JSON.stringify({ answer: answer }), {
        headers: { 'Content-Type': 'application/json' },
    });
  },
};