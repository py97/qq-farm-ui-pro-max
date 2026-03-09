/**
 * OpenViking Context Management Client
 * 用于与 OpenViking Python 服务通信的 Node.js 客户端
 */

class OpenVikingClient {
  constructor(baseURL = 'http://localhost:5432') {
    this.baseURL = baseURL;
    this.timeoutMs = 30000;
  }

  async request(method, pathname, options = {}) {
    const { params, body } = options;
    const url = new URL(pathname, this.baseURL);
    if (params && typeof params === 'object') {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!response.ok) {
      const errorMessage = data.error || data.message || `${response.status} ${response.statusText}`;
      throw new Error(errorMessage);
    }

    return data;
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      return await this.request('GET', '/health');
    } catch (error) {
      throw new Error(`健康检查失败：${error.message}`);
    }
  }

  /**
   * 添加资源（文档、代码等）
   * @param {string} path - 资源路径（URL 或文件路径）
   * @param {string} name - 资源名称
   */
  async addResource(path, name = 'default') {
    try {
      return await this.request('POST', '/api/resource/add', {
        body: {
          path,
          name,
        },
      });
    } catch (error) {
      throw new Error(`添加资源失败：${error.message}`);
    }
  }

  /**
   * 列出资源
   * @param {string} uri - 资源 URI，默认为 viking://resources/
   */
  async listResources(uri = 'viking://resources/') {
    try {
      return await this.request('GET', '/api/resource/list', {
        params: { uri },
      });
    } catch (error) {
      throw new Error(`列出资源失败：${error.message}`);
    }
  }

  /**
   * 搜索资源
   * @param {string} query - 搜索查询
   * @param {string} targetUri - 目标 URI
   */
  async searchResource(query, targetUri = 'viking://resources/') {
    try {
      return await this.request('POST', '/api/resource/search', {
        body: {
          query,
          target_uri: targetUri,
        },
      });
    } catch (error) {
      throw new Error(`搜索资源失败：${error.message}`);
    }
  }

  /**
   * 读取资源内容
   * @param {string} uri - 资源 URI
   */
  async readResource(uri) {
    try {
      return await this.request('POST', '/api/resource/read', {
        body: { uri },
      });
    } catch (error) {
      throw new Error(`读取资源失败：${error.message}`);
    }
  }

  /**
   * 获取资源摘要
   * @param {string} uri - 资源 URI
   */
  async getAbstract(uri) {
    try {
      return await this.request('POST', '/api/resource/abstract', {
        body: { uri },
      });
    } catch (error) {
      throw new Error(`获取摘要失败：${error.message}`);
    }
  }

  /**
   * 获取资源概览
   * @param {string} uri - 资源 URI
   */
  async getOverview(uri) {
    try {
      return await this.request('POST', '/api/resource/overview', {
        body: { uri },
      });
    } catch (error) {
      throw new Error(`获取概览失败：${error.message}`);
    }
  }

  /**
   * 添加记忆
   * @param {string} content - 记忆内容
   * @param {string} category - 记忆分类
   */
  async addMemory(content, category = 'general') {
    try {
      return await this.request('POST', '/api/memory/add', {
        body: {
          content,
          category,
        },
      });
    } catch (error) {
      throw new Error(`添加记忆失败：${error.message}`);
    }
  }

  /**
   * 列出记忆
   * @param {string} category - 记忆分类（可选）
   */
  async listMemories(category = '') {
    try {
      return await this.request('GET', '/api/memory/list', {
        params: { category },
      });
    } catch (error) {
      throw new Error(`列出记忆失败：${error.message}`);
    }
  }

  /**
   * 获取上下文（用于 AI 编程）
   * @param {string} query - 查询内容
   * @param {boolean} includeMemories - 是否包含记忆
   * @param {boolean} includeResources - 是否包含资源
   */
  async getContext(query, includeMemories = true, includeResources = true) {
    try {
      return await this.request('POST', '/api/context/get', {
        body: {
          query,
          include_memories: includeMemories,
          include_resources: includeResources,
        },
      });
    } catch (error) {
      throw new Error(`获取上下文失败：${error.message}`);
    }
  }

  /**
   * 清除上下文
   */
  async clearContext() {
    try {
      return await this.request('POST', '/api/context/clear');
    } catch (error) {
      throw new Error(`清除上下文失败：${error.message}`);
    }
  }

  /**
   * 关闭服务
   */
  async shutdown() {
    try {
      return await this.request('POST', '/shutdown');
    } catch (error) {
      throw new Error(`关闭服务失败：${error.message}`);
    }
  }
}

module.exports = OpenVikingClient;
