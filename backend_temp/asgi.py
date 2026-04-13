import os

import uvicorn

from main import app


def main():
    uvicorn.run(
        "asgi:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        reload=False,
    )


if __name__ == "__main__":
    main()
