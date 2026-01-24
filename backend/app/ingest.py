import os
from pathlib import Path
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[2]
load_dotenv(ROOT_DIR / ".env")

from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma
from langchain_community.document_loaders import TextLoader, DirectoryLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter

DATA_DIR = ROOT_DIR / "data" / "knowledge"
PERSIST_DIR = ROOT_DIR / "data" / "chroma_db"
COLLECTION = "elaralo"

def build_index():
    if not os.getenv("OPENAI_API_KEY"):
        raise EnvironmentError("OPENAI_API_KEY is missing. Check .env loading.")

    loader = DirectoryLoader(
        str(DATA_DIR),
        glob="**/*.*",
        loader_cls=TextLoader,
        loader_kwargs={"encoding": "utf-8"},
        show_progress=True,
        silent_errors=True,
    )
    docs = loader.load()
    print(f"Loaded {len(docs)} raw documents from {DATA_DIR}")

    splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=120)
    docs = splitter.split_documents(docs)
    print(f"Split into {len(docs)} chunks")

    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")

    vectordb = Chroma.from_documents(
        documents=docs,
        embedding=embeddings,
        persist_directory=str(PERSIST_DIR),
        collection_name=COLLECTION,
    )

    print("✅ Chroma index built and persisted.")

if __name__ == "__main__":
    PERSIST_DIR.mkdir(parents=True, exist_ok=True)
    build_index()
