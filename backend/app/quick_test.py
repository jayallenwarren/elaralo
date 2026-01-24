import os
from pathlib import Path
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[2]  # backend/
load_dotenv(ROOT_DIR / ".env")

from langchain_openai import OpenAIEmbeddings
from langchain_chroma import Chroma

db = Chroma(
    collection_name="elaralo",
    persist_directory="data/chroma_db",
    embedding_function=OpenAIEmbeddings(model="text-embedding-3-small"),
)

res = db.similarity_search("How should Elaralo handle consent?", k=3)
for i, r in enumerate(res):
    print("\n---", i, "---")
    print(r.page_content[:600])
