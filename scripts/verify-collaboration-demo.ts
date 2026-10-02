import { spawnSync } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const videoPath = resolve('site/collaboration-demo.webm')
const video = await stat(videoPath)
if (video.size === 0) throw new Error('Collaboration demo video is empty')

const probe = spawnSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
], { encoding: 'utf8' })
if (probe.error) throw probe.error
if (probe.status !== 0) throw new Error(`ffprobe could not read collaboration demo: ${probe.stderr}`)
const durationSeconds = Number(probe.stdout.trim())
if (!Number.isFinite(durationSeconds) || durationSeconds < 60) {
  throw new Error(`Collaboration demo must be at least 60 seconds; got ${probe.stdout.trim()} seconds`)
}

const playback = spawnSync('ffmpeg', ['-v', 'error', '-i', videoPath, '-f', 'null', '-'], { encoding: 'utf8' })
if (playback.error) throw playback.error
if (playback.status !== 0) throw new Error(`Collaboration demo did not play through: ${playback.stderr}`)
console.log(`Collaboration demo is ${durationSeconds.toFixed(1)} seconds and decodes from start to finish.`)
