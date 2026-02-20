"""日志配置"""

import logging
import logging.handlers
import sys
from pathlib import Path

# 创建日志目录
log_dir = Path("logs")
log_dir.mkdir(exist_ok=True)

# 配置日志格式
log_format = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
date_format = "%Y-%m-%d %H:%M:%S"

# 创建 logger
logger = logging.getLogger("grok2api")
logger.setLevel(logging.DEBUG)

# 控制台处理器
console_handler = logging.StreamHandler(sys.stdout)
console_handler.setLevel(logging.INFO)
console_formatter = logging.Formatter(log_format, date_format)
console_handler.setFormatter(console_formatter)

# 文件处理器（启动时从配置读取大小）
def _get_max_bytes():
    try:
        from app.core.config import settings
        return settings.max_log_file_mb * 1024 * 1024
    except Exception:
        return 10 * 1024 * 1024

file_handler = logging.handlers.RotatingFileHandler(
    log_dir / "grok2api.log",
    maxBytes=_get_max_bytes(),
    backupCount=0,
    encoding="utf-8"
)
file_handler.setLevel(logging.DEBUG)
file_formatter = logging.Formatter(log_format, date_format)
file_handler.setFormatter(file_formatter)

# 添加处理器
logger.addHandler(console_handler)
logger.addHandler(file_handler)
