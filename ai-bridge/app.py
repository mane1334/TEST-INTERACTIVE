import io
import os
import tempfile
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
import riva.client

app = FastAPI(title="AI Bridge (NVIDIA ASR/TTS)")


def _get_api_key():
    return os.getenv("NVIDIA_API_KEY") or os.getenv("NGC_API_KEY")


def _make_auth(function_id: str):
    api_key = _get_api_key()
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY/NGC_API_KEY não configurado.")

    target = os.getenv("NVIDIA_GRPC_TARGET", "grpc.nvcf.nvidia.com:443")
    use_ssl = os.getenv("NVIDIA_GRPC_USE_SSL", "true").lower() != "false"
    metadata = [
        ("authorization", f"Bearer {api_key}"),
        ("function-id", function_id),
    ]
    return riva.client.Auth(uri=target, use_ssl=use_ssl, metadata_args=metadata)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/asr")
async def asr(file: UploadFile = File(...), language_code: str = "multi"):
    function_id = os.getenv("NVIDIA_ASR_FUNCTION_ID", "b702f636-f60c-4a3d-a6f4-f3568c13bd7d")

    try:
        auth = _make_auth(function_id)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    try:
        audio_bytes = await file.read()
        with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file.filename or "audio.wav")[1] or ".wav") as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        config = riva.client.RecognitionConfig(
            language_code=language_code,
            max_alternatives=1,
            enable_automatic_punctuation=True,
        )
        riva.client.add_audio_file_specs_to_config(config, tmp_path)

        asr_service = riva.client.ASRService(auth)
        resp = asr_service.offline_recognize(audio_bytes, config)
        text = " ".join([r.alternatives[0].transcript for r in resp.results if r.alternatives])

        try:
            os.unlink(tmp_path)
        except OSError:
            pass

        return JSONResponse({"text": text})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ASR failed: {e}")


@app.post("/tts")
async def tts(payload: dict):
    function_id = os.getenv("NVIDIA_TTS_FUNCTION_ID")
    if not function_id:
        raise HTTPException(status_code=500, detail="NVIDIA_TTS_FUNCTION_ID não configurado.")

    text = payload.get("text")
    if not text:
        raise HTTPException(status_code=400, detail="Campo 'text' é obrigatório.")

    language_code = payload.get("language_code", "pt-BR")
    voice_name = payload.get("voice_name")
    sample_rate_hz = int(payload.get("sample_rate_hz", 22050))

    try:
        auth = _make_auth(function_id)
        tts_service = riva.client.SpeechSynthesisService(auth)
        audio = tts_service.synthesize(
            text=text,
            language_code=language_code,
            voice_name=voice_name,
            sample_rate_hz=sample_rate_hz,
        )
        return StreamingResponse(io.BytesIO(audio), media_type="audio/wav")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS failed: {e}")
