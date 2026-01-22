import os
from datetime import datetime, timedelta
from typing import Optional
from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import sessionmaker, declarative_base, relationship, Session as OrmSession

DB_URL = os.environ.get("DATABASE_URL", "sqlite:///./data.db")
engine = create_engine(DB_URL, connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    tier = Column(String, default="trial")
    dob = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    sessions = relationship("ChatSession", back_populates="user")
    purchases = relationship("Purchase", back_populates="user")

class ChatSession(Base):
    __tablename__ = "sessions"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    mode = Column(String)
    is_tts = Column(Boolean, default=False)
    started_at = Column(DateTime, default=datetime.utcnow)
    stopped_at = Column(DateTime, nullable=True)
    active_seconds = Column(Integer, default=0)
    user = relationship("User", back_populates="sessions")

class Purchase(Base):
    __tablename__ = "purchases"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    channel = Column(String)
    seconds_remaining = Column(Integer, default=0)
    sku = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime)
    user = relationship("User", back_populates="purchases")

Base.metadata.create_all(engine)

app = FastAPI(title="Elaralo Web App Service", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

POOL = {"trial":600, "member_friend":900, "member_romantic":2700, "member_intimate":6300}
CAP = {"friend":900, "romantic":1800, "intimate":3600}

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

class StartIn(BaseModel):
    user_id:int; tier:str; mode:str; is_tts:bool=False
class StartOut(BaseModel):
    session_id:int; cap_seconds:int; remaining_included_30d:int; purchased_tts_seconds:int; purchased_text_seconds:int
class TickIn(BaseModel):
    session_id:int; delta_seconds:int; is_active:bool; tier:str; mode:str; is_tts:bool
class TickOut(BaseModel):
    remaining_session_seconds:int; included_remaining_30d:int; purchased_tts_seconds:int; purchased_text_seconds:int
class PurchaseIn(BaseModel):
    user_id:int; sku:str; channel:str
class UsageOut(BaseModel):
    included_remaining_30d:int; purchased_text_seconds:int; purchased_tts_seconds:int

@app.get("/health")
def health(): return {"ok":True,"ts":datetime.utcnow().isoformat()}

from sqlalchemy import func
def used_30d(db:OrmSession, uid:int)->int:
    cutoff = datetime.utcnow()-timedelta(days=30)
    rows = db.query(ChatSession).filter(ChatSession.user_id==uid, ChatSession.started_at>=cutoff).with_entities(ChatSession.active_seconds).all()
    return sum(r[0] for r in rows)

def purchased(db:OrmSession, uid:int, channel:str)->int:
    now=datetime.utcnow()
    rows = db.query(Purchase).filter(Purchase.user_id==uid, Purchase.channel==channel, Purchase.expires_at>now, Purchase.seconds_remaining>0).all()
    return sum(p.seconds_remaining for p in rows)

@app.post("/seed")
def seed(db:OrmSession=Depends(get_db)):
    u=User(tier="trial"); db.add(u); db.commit(); db.refresh(u); return {"user_id":u.id,"tier":u.tier}

@app.post("/session/start", response_model=StartOut)
def start(inp:StartIn, db:OrmSession=Depends(get_db)):
    u = db.get(User, inp.user_id) or User(id=inp.user_id, tier=inp.tier)
    u.tier = inp.tier; db.add(u); db.commit()
    cap = 600 if (inp.tier=="trial" and inp.mode=="friend") else CAP.get(inp.mode,0)
    if cap==0: raise HTTPException(403,"Upgrade required")
    s=ChatSession(user_id=u.id, mode=inp.mode, is_tts=inp.is_tts); db.add(s); db.commit(); db.refresh(s)
    inc = max(0, POOL.get(u.tier,0)-used_30d(db, u.id))
    return StartOut(session_id=s.id, cap_seconds=cap, remaining_included_30d=inc,
                    purchased_tts_seconds=purchased(db,u.id,"tts"),
                    purchased_text_seconds=purchased(db,u.id,"text"))

@app.post("/session/tick", response_model=TickOut)
def tick(inp:TickIn, db:OrmSession=Depends(get_db)):
    s = db.get(ChatSession, inp.session_id) or HTTPException(404,"Session not found")
    if inp.is_active: s.active_seconds += max(0,int(inp.delta_seconds)); db.commit()
    cap = 600 if (inp.tier=="trial" and inp.mode=="friend") else CAP.get(inp.mode,0)
    rem = max(0, cap - s.active_seconds)
    if rem==0: raise HTTPException(402,"TIME LIMIT REACHED")
    inc = max(0, POOL.get(inp.tier,0)-used_30d(db, s.user_id))
    ch = "tts" if inp.is_tts else "text"
    if inc==0 and purchased(db, s.user_id, ch)==0: raise HTTPException(402,"BALANCE REQUIRED")
    return TickOut(remaining_session_seconds=rem, included_remaining_30d=inc,
                   purchased_tts_seconds=purchased(db,s.user_id,"tts"),
                   purchased_text_seconds=purchased(db,s.user_id,"text"))

SKU_SEC={"tts_15m_499":900,"tts_30m_999":1800,"tts_60m_1499":3600,"text_15m_099":900,"text_30m_299":1800,"text_60m_599":3600}

@app.post("/minutes/purchase")
def minutes(inp:PurchaseIn, db:OrmSession=Depends(get_db)):
    sec = SKU_SEC.get(inp.sku); 
    if sec is None: raise HTTPException(400,"Unknown SKU")
    p = Purchase(user_id=inp.user_id, channel=inp.channel, seconds_remaining=sec, sku=inp.sku, expires_at=datetime.utcnow()+timedelta(days=365))
    db.add(p); db.commit(); return {"ok":True,"purchase_id":p.id,"seconds":sec}

@app.get("/usage/summary", response_model=UsageOut)
def usage(user_id:int, tier:str, db:OrmSession=Depends(get_db)):
    inc=max(0, POOL.get(tier,0)-used_30d(db,user_id))
    return UsageOut(included_remaining_30d=inc,
                    purchased_text_seconds=purchased(db,user_id,"text"),
                    purchased_tts_seconds=purchased(db,user_id,"tts"))
