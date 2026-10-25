import { readLogTail } from '../../tasks/logs.js';

/**
 * 服务日志接口。
 *
 * 安全：只读 data/autochat.out 与 data/autochat.err 两个固定文件，
 * 路径不可由请求参数指定；行数与字节都有上限。
 */
export const routes = {
  'GET /api/logs': async ({ url }) => {
    const tail = Number(url.searchParams.get('tail') || 200) || 200;
    const err = url.searchParams.get('err') === '1';
    const r = readLogTail({ lines: tail, err });
    return { status: 200, body: r };
  },
};
