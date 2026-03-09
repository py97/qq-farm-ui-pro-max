/**
 * OpenViking 服务测试脚本
 */

const OpenVikingClient = require('../client');

async function testOpenVikingService() {
  console.log('🧪 开始测试 OpenViking 服务...\n');

  const client = new OpenVikingClient('http://localhost:5432');

  try {
    // 1. 健康检查
    console.log('📌 测试 1: 健康检查');
    const health = await client.healthCheck();
    console.log('✅ 健康检查通过:', health);
    console.log('');

    // 2. 添加资源
    console.log('📌 测试 2: 添加资源');
    const addResult = await client.addResource(
      'https://github.com/example/repo',
      'test-repo'
    );
    console.log('✅ 资源添加成功:', addResult);
    console.log('');

    // 3. 列出资源
    console.log('📌 测试 3: 列出资源');
    const listResult = await client.listResources();
    console.log('✅ 资源列表:', listResult);
    console.log('');

    // 4. 搜索资源
    console.log('📌 测试 4: 搜索资源');
    const searchResult = await client.searchResource('test');
    console.log('✅ 搜索结果:', searchResult);
    console.log('');

    // 5. 添加记忆
    console.log('📌 测试 5: 添加记忆');
    const memoryResult = await client.addMemory(
      '测试记忆：喜欢使用 TypeScript 进行开发',
      'preferences'
    );
    console.log('✅ 记忆添加成功:', memoryResult);
    console.log('');

    // 6. 列出记忆
    console.log('📌 测试 6: 列出记忆');
    const memories = await client.listMemories();
    console.log('✅ 记忆列表:', memories);
    console.log('');

    // 7. 获取上下文
    console.log('📌 测试 7: 获取上下文');
    const contextResult = await client.getContext('TypeScript');
    console.log('✅ 上下文获取成功');
    console.log('上下文内容:', contextResult.context?.substring(0, 200) + '...');
    console.log('');

    // 8. 清除上下文
    console.log('📌 测试 8: 清除上下文');
    const clearResult = await client.clearContext();
    console.log('✅ 上下文已清除:', clearResult);
    console.log('');

    console.log('✅ 所有测试通过！');

  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    process.exit(1);
  } finally {
    // 关闭服务（可选）
    // await client.shutdown();
  }
}

// 运行测试
testOpenVikingService().catch(error => {
  console.error('测试执行失败:', error);
  process.exit(1);
});
