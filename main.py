import asyncio
import base64
import datetime
import glob
import json
import os
import re
import ssl

import aiohttp
import certifi

import decky  # type: ignore
from settings import SettingsManager  # type: ignore


class Plugin:
    yt_process: asyncio.subprocess.Process | None = None
    # We need this lock to make sure the process output isn't read by two concurrent readers at once.
    yt_process_lock = asyncio.Lock()
    music_path = f"{decky.DECKY_PLUGIN_RUNTIME_DIR}/music"
    cache_path = f"{decky.DECKY_PLUGIN_RUNTIME_DIR}/cache"
    ssl_context = ssl.create_default_context(cafile=certifi.where())

    async def _main(self):
        self.settings = SettingsManager(
            name="config", settings_directory=decky.DECKY_PLUGIN_SETTINGS_DIR
        )

    async def _unload(self):
        await self._stop_search_process()

    async def set_setting(self, key, value):
        self.settings.setSetting(key, value)

    async def get_setting(self, key, default):
        return self.settings.getSetting(key, default)

    yt_dlp_path = f"{decky.DECKY_PLUGIN_DIR}/bin/yt-dlp"
    # Incremented for every search so the frontend can only stop its own search.
    search_id = 0
    # Video IDs currently being downloaded, so the same song isn't fetched twice at once.
    downloads_in_progress: set[str] = set()

    @staticmethod
    def _log_stderr(what: str, returncode: int | None, stderr: bytes | None):
        text = (stderr or b"").decode(errors="replace").strip()
        decky.logger.error(f"yt-dlp {what} exited with {returncode}: {text[-2000:]}")

    async def _drain_stderr(self, process: asyncio.subprocess.Process, what: str):
        # Read stderr as it arrives so the pipe never fills up, and log it on failure.
        if process.stderr is None:
            return
        chunks = []
        async for line in process.stderr:
            chunks.append(line)
        await process.wait()
        # -15 means we terminated it ourselves (SIGTERM), which isn't an error.
        if process.returncode not in (0, -15):
            self._log_stderr(what, process.returncode, b"".join(chunks))

    async def _stop_search_process(self):
        process = self.yt_process
        if process is None or process.returncode is not None:
            return
        try:
            process.terminate()
            await asyncio.wait_for(process.wait(), timeout=5)
        except ProcessLookupError:
            pass
        except asyncio.TimeoutError:
            process.kill()

    async def search_yt(self, term: str):
        await self._stop_search_process()
        self.search_id += 1
        self.yt_process = await asyncio.create_subprocess_exec(
            self.yt_dlp_path,
            "-j",
            "-f",
            "bestaudio",
            "--match-filters",
            f"duration<?{20*60}",  # 20 minutes is too long.
            "--no-warnings",
            "--ignore-errors",
            "--",
            f"ytsearch10:{term}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            # The returned JSON can get rather big, so we set a generous limit of 10 MB.
            limit=10 * 1024**2,
        )
        asyncio.create_task(self._drain_stderr(self.yt_process, f"search {term!r}"))
        return self.search_id

    async def stop_search(self, search_id: int):
        # Stop a search once the caller has what it needs, so yt-dlp doesn't keep
        # resolving the remaining results (and hitting YouTube) in the background.
        if search_id == self.search_id:
            await self._stop_search_process()

    async def next_yt_result(self):
        async with self.yt_process_lock:
            if not self.yt_process or not (output := self.yt_process.stdout):
                return None
            # Skip entries without an extractable audio URL (eg age-gated, region-locked)
            # rather than aborting the whole search.
            while True:
                line = (await output.readline()).strip()
                if not line:
                    return None
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                info = self.entry_to_info(entry)
                if info is not None:
                    return info

    @staticmethod
    def entry_to_info(entry):
        url = entry.get("url")
        if not url:
            return None
        return {
            "url": url,
            "title": entry.get("title", ""),
            "id": entry.get("id", ""),
            "thumbnail": entry.get("thumbnail", ""),
        }

    def local_match(self, id: str) -> str | None:
        local_matches = [
            x
            for x in glob.glob(f"{glob.escape(self.music_path)}/{glob.escape(id)}.*")
            # Skip yt-dlp's in-progress files (eg "id.webm.part").
            if os.path.isfile(x) and not x.endswith((".part", ".ytdl", ".temp"))
        ]
        if len(local_matches) == 0:
            return None
        if len(local_matches) > 1:
            decky.logger.warning(f"More than one downloaded audio for {id}: {local_matches}")
        return sorted(local_matches)[0]

    @staticmethod
    def to_data_url(path: str) -> str:
        # We cannot use local paths in the <audio> elements, so we'll
        # convert this to a base64-encoded data URL first.
        extension = path.split(".")[-1]
        with open(path, "rb") as file:
            return f"data:audio/{extension};base64,{base64.b64encode(file.read()).decode()}"

    async def local_yt_audio(self, id: str):
        # Local-only lookup used for play-on-highlight: never runs yt-dlp or touches the network.
        if not isinstance(id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", id):
            return None
        try:
            local_match = self.local_match(id)
            if local_match is None:
                return None
            return self.to_data_url(local_match)
        except Exception as e:
            decky.logger.error(f"local_yt_audio({id}) failed: {e}")
            return None

    async def single_yt_url(self, id: str):
        local_match = self.local_match(id)
        if local_match is not None:
            # The audio has already been downloaded, so we can just use that one.
            return self.to_data_url(local_match)
        process = await asyncio.create_subprocess_exec(
            self.yt_dlp_path,
            "-j",
            "-f",
            "bestaudio",
            "--no-warnings",
            # "--" so IDs starting with "-" aren't parsed as options.
            "--",
            id,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            self._log_stderr(f"lookup {id}", process.returncode, stderr)
            return None
        try:
            entry = json.loads(stdout.strip())
        except json.JSONDecodeError:
            decky.logger.error(f"yt-dlp lookup {id} returned invalid JSON")
            return None
        return entry.get("url")

    async def download_yt_audio(self, id: str) -> bool:
        if not isinstance(id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", id):
            decky.logger.error(f"download_yt_audio: invalid video ID {id!r}")
            return False
        if self.local_match(id) is not None:
            # Already downloaded—there's nothing we need to do.
            return True
        if id in self.downloads_in_progress:
            # Another caller (eg a background download) is already fetching it; wait for that.
            while id in self.downloads_in_progress:
                await asyncio.sleep(0.5)
            return self.local_match(id) is not None
        self.downloads_in_progress.add(id)
        try:
            process = await asyncio.create_subprocess_exec(
                self.yt_dlp_path,
                "-f",
                "bestaudio",
                "--no-warnings",
                "-o",
                "%(id)s.%(ext)s",
                "-P",
                self.music_path,
                # "--" so IDs starting with "-" aren't parsed as options.
                "--",
                id,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await process.communicate()
        finally:
            self.downloads_in_progress.discard(id)
        if process.returncode != 0:
            self._log_stderr(f"download {id}", process.returncode, stderr)
            return False
        if self.local_match(id) is None:
            decky.logger.error(f"yt-dlp download {id} succeeded but no file was found")
            return False
        decky.logger.info(f"Downloaded {id}")
        return True

    async def download_url(self, url: str, id: str):
        async with aiohttp.ClientSession() as session:
            res = await session.get(url, ssl=self.ssl_context)
            res.raise_for_status()
            with open(f"{self.music_path}/{id}.webm", "wb") as file:
                async for chunk in res.content.iter_chunked(1024):
                    file.write(chunk)

    async def clear_downloads(self):
        for file in glob.glob(f"{self.music_path}/*"):
            if os.path.isfile(file):
                os.remove(file)

    async def export_cache(self, cache: dict):
        os.makedirs(self.cache_path, exist_ok=True)
        filename = f"backup-{datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}.json"
        with open(f"{self.cache_path}/{filename}", "w") as file:
            json.dump(cache, file)

    async def list_cache_backups(self):
        return [
            file.split("/")[-1].rsplit(".", 1)[0]
            for file in glob.glob(f"{self.cache_path}/*")
        ]

    async def import_cache(self, name: str):
        with open(f"{self.cache_path}/{name}.json", "r") as file:
            return json.load(file)

    async def clear_cache(self):
        for file in glob.glob(f"{self.cache_path}/*"):
            if os.path.isfile(file):
                os.remove(file)
