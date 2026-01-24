import os
from pathlib import Path
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[2]  # backend/
load_dotenv(ROOT_DIR / ".env")

from langchain_openai import OpenAIEmbeddings

try:
    from langchain_chroma import Chroma
except ImportError:
    from langchain_community.vectorstores import Chroma

PERSIST_DIR = ROOT_DIR / "data" / "chroma_db"
COLLECTION_NAME = "elaralo"

def get_retriever(k: int = 4):
    if not os.getenv("OPENAI_API_KEY"):
        raise EnvironmentError("OPENAI_API_KEY is missing. Check .env loading.")

    if not PERSIST_DIR.exists():
        raise FileNotFoundError(
            f"Chroma DB not found at {PERSIST_DIR}. Run ingest.py first."
        )

    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")

    db = Chroma(
        collection_name=COLLECTION_NAME,
        persist_directory=str(PERSIST_DIR),
        embedding_function=embeddings,
    )

    return db.as_retriever(search_kwargs={"k": k})
