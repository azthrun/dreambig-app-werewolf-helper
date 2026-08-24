"""开发用静态服务器 —— 与 python -m http.server 相同，仅额外发 no-store。

浏览器对 http.server 的启发式缓存会让改动无法在预览中生效（样式与脚本被钉在旧
版本上），逐屏改界面时几乎每次都要手动清缓存。仅用于本地开发，不参与部署。
"""
import sys
from http.server import SimpleHTTPRequestHandler, test


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()


if __name__ == '__main__':
    test(HandlerClass=NoCacheHandler, port=int(sys.argv[1]) if len(sys.argv) > 1 else 8642)
