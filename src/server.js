const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');

const app = express();
const port = 3000;

const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

const sessions = new Map();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Range', 'User-Agent'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));

app.use(bodyParser.json({ type: ['application/json', 'text/plain'] }));

app.get('/api/video-info', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        exec(`yt-dlp --dump-json "${url}"`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                return res.status(500).json({ error: 'Failed to fetch video info' });
            }

            const videoInfo = JSON.parse(stdout);

            return res.json({
                videoId: videoInfo.id,
                title: videoInfo.title,
                author: videoInfo.uploader,
                thumbnailUrl: videoInfo.thumbnail
            });
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/stream-audio', async (req, res) => {
    try {
        const { url } = req.query;
        const sessionId = req.query.sessionId || Date.now().toString();

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const outputFile = path.join(downloadsDir, `${sessionId}.wav`);

        sessions.set(sessionId, { file: outputFile, lastAccessed: Date.now() });

        if (!fs.existsSync(outputFile)) {
            console.log(`Downloading: ${url} to ${outputFile}`);

            const downloadProcess = exec(
                `yt-dlp -x --audio-format wav -o "${outputFile}" "${url}"`,
                (error) => {
                    if (error) {
                        console.error(`Download error: ${error.message}`);
                    }
                }
            );

            await new Promise((resolve, reject) => {
                downloadProcess.on('exit', (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`Download process exited with code ${code}`));
                    }
                });
                downloadProcess.on('error', reject);
            });
        }


        const stat = fs.statSync(outputFile);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(outputFile, { start, end });

            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'audio/wav',
            };

            res.writeHead(206, head);
            file.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'audio/wav',
                'Accept-Ranges': 'bytes'
            };

            res.writeHead(200, head);
            fs.createReadStream(outputFile).pipe(res);
        }

        sessions.set(sessionId, { ...sessions.get(sessionId), lastAccessed: Date.now() });

    } catch (error) {
        console.error('Error streaming audio:', error);

        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream audio' });
        }
    }
});

app.post('/api/cleanup', (req, res) => {
    if (!req.body) {
        return res.status(400).json({ error: 'No request body sent.' });
    }

    const { sessionId } = req.body;

    if (sessionId && sessions.has(sessionId)) {
        const sessionData = sessions.get(sessionId);

        try {
            if (fs.existsSync(sessionData.file)) {
                fs.unlinkSync(sessionData.file);
            }
            sessions.delete(sessionId);
            res.json({ success: true });
        } catch (error) {
            console.error('Error cleaning up:', error);
            res.status(500).json({ error: 'Failed to cleanup' });
        }
    } else {
        res.status(400).json({ error: 'Invalid session ID' });
    }
});

setInterval(() => {
    const now = Date.now();
    const expireTime = 30 * 60 * 1000;

    sessions.forEach((sessionData, sessionId) => {
        if (now - sessionData.lastAccessed > expireTime) {
            try {
                if (fs.existsSync(sessionData.file)) {
                    fs.unlinkSync(sessionData.file);
                    console.log(`Deleted expired file: ${sessionData.file}`);
                }
                sessions.delete(sessionId);
            } catch (error) {
                console.error(`Error deleting expired file: ${error}`);
            }
        }
    });
}, 30 * 60 * 1000);


process.on('SIGINT', () => {
    console.log('Server shutting down, cleaning up files...');

    sessions.forEach((sessionData) => {
        try {
            if (fs.existsSync(sessionData.file)) {
                fs.unlinkSync(sessionData.file);
            }
        } catch (error) {
            console.error(`Error during shutdown cleanup: ${error}`);
        }
    });

    setTimeout(() => {
        process.exit(0);
    }, 50);
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});