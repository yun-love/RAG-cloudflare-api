export default {
  async fetch(request, env) {
    // 出于安全考虑，您可能希望添加一个密码或密钥来触发此操作
    console.log("Starting ingestion process...");

    // 1. 从 R2 列出所有文档
    const listed = await env.RAG_BUCKET.list();
    const objects = listed.objects;

    // 2. 遍历每个文档
    for (const obj of objects) {
      const document = await env.RAG_BUCKET.get(obj.key);
      const documentText = await document.text();

      // 在实际应用中，您应该将长文档分割成更小的块（chunks）
      const chunks = [documentText]; // 简化为一整个文档作为一个块

      // 3. 为每个块生成向量并插入 Vectorize
      const embeddings = await env.AI.run(
        '@cf/baai/bge-base-en-v1.5',
        { text: chunks }
      );

      const vectors = embeddings.data.map((embedding, i) => ({
        id: `${obj.key}-chunk-${i}`, // 确保 ID 唯一
        values: embedding,
        metadata: { text: chunks[i] }, // 将原始文本存入元数据！
      }));

      await env.VECTORIZE_INDEX.insert(vectors);
      console.log(`Ingested and vectorized: ${obj.key}`);
    }

    return new Response("Ingestion process completed successfully!");
  },
};