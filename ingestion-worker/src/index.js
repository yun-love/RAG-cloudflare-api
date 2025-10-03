// 一个简单的分块函数
function splitIntoChunks(text, chunkSize = 300, overlap = 50) {
  const sentences = text.split(/(?<=[。？！.!?])\s+/); // 按句子分割
  const chunks = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > chunkSize) {
      chunks.push(currentChunk.trim());
      currentChunk = currentChunk.slice(-(overlap)) + sentence; // 添加重叠部分
    } else {
      currentChunk += sentence;
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}


export default {
  async fetch(request, env) {
    console.log("Starting ingestion process with chunking...");

    // 1. 从 R2 列出所有文档
    const listed = await env.RAG_BUCKET.list();
    if (!listed.objects) {
      return new Response("No objects found in R2 bucket.", { status: 404 });
    }

    const BATCH_SIZE = 50; // Vectorize 一次最多插入 100 个向量，我们用 50 保证安全
    let vectorsToInsert = [];

    // 2. 遍历每个文档
    for (const obj of listed.objects) {
      console.log(`Processing file: ${obj.key}`);
      const document = await env.RAG_BUCKET.get(obj.key);
      if (!document) continue;

      const documentText = await document.text();

      // 3. 【关键】将文档文本分割成小块
      const chunks = splitIntoChunks(documentText);
      console.log(`File ${obj.key} was split into ${chunks.length} chunks.`);

      if (chunks.length === 0) continue;

      // 4. 为所有块生成向量嵌入 (一次性批量处理)
      const embeddingsResponse = await env.AI.run(
        '@cf/baai/bge-base-en-v1.5',
        { text: chunks }
      );
      const embeddings = embeddingsResponse.data;

      // 5. 准备要插入的向量对象
      for (let i = 0; i < embeddings.length; i++) {
        vectorsToInsert.push({
          id: `${obj.key}-chunk-${i}`, // 确保 ID 唯一
          values: embeddings[i],
          metadata: { text: chunks[i], source: obj.key }, // 将原始文本和来源存入元数据
        });

        // 当累积的向量达到批量大小时，就插入一次
        if (vectorsToInsert.length >= BATCH_SIZE) {
          await env.VECTORIZE_INDEX.insert(vectorsToInsert);
          console.log(`Inserted a batch of ${vectorsToInsert.length} vectors.`);
          vectorsToInsert = []; // 清空数组
        }
      }
    }
    
    // 插入最后一批剩余的向量
    if (vectorsToInsert.length > 0) {
      await env.VECTORIZE_INDEX.insert(vectorsToInsert);
      console.log(`Inserted the final batch of ${vectorsToInsert.length} vectors.`);
    }

    return new Response("Ingestion process with chunking completed successfully!");
  },
};