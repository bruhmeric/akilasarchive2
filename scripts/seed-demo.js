#!/usr/bin/env node
/**
 * Seed a local demo database — FOR LOCAL TESTING ONLY.
 * Lets you exercise the terminal/search/one-time-link flow without any R2
 * credentials. Run from app/:  DATA_DIR=./data-demo node ../scripts/seed-demo.js
 * Then start the server with the same DATA_DIR.
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')
const appDir = path.join(root, 'app')
const dataDir = process.env.DATA_DIR ?? path.join(root, 'data-demo')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

process.env.DATA_DIR = dataDir
process.env.R2_ACCOUNT_ID ??= '00000000000000000000000000000000'
process.env.R2_ACCESS_KEY_ID ??= 'dummy'
process.env.R2_SECRET_ACCESS_KEY ??= 'dummy'
process.env.DOWNLOAD_SECRET ??= 'test-download-secret-0123456789abcdef'
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef'
process.env.ADMIN_PASSWORD ??= 'test1234'
process.env.DL_MODE ??= 'worker'
process.env.DOWNLOAD_BASE_URL ??= 'https://dl.example.test'

const { db, setMeta } = await import(path.join(appDir, 'src/db.js'))
const { scryptHash } = await import(path.join(appDir, 'src/util.js'))

const movies = [
  ['Action/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x265.mkv', 4831838208, 1700000000000],
  ['Action/The Matrix Reloaded (2003)/matrix.reloaded.2003.720p.mkv', 2899102924, 1700000001000],
  ['Sci-Fi/Dune Part Two (2024)/Dune.Part.Two.2024.2160p.WEB-DL.mkv', 34359738368, 1712000000000],
  ['Sci-Fi/Interstellar (2014)/Interstellar.2014.IMAX.1080p.mkv', 4123168604, 1600000000000],
  ['Animation/Spirited Away (2001)/spirited.away.2001.1080p.bluray.mkv', 2298750000, 1590000000000],
  ['Movies In Tamil/சினிமா படம்.2023.1080p.mkv', 3400000000, 1720000000000],
  ['Classics/Casablanca (1942)/casablanca.1942.720p.mkv', 990000000, 1200000000000]
]

const tv = [
  ['Breaking Bad/Season 05/breaking.bad.s05e01.720p.mkv', 1200000000, 1660000000000],
  ['Breaking Bad/Season 05/breaking.bad.s05e02.720p.mkv', 1180000000, 1660000001000],
  ['Breaking Bad/Season 05/breaking.bad.s05e03.720p.mkv', 1190000000, 1660000002000],
  ['Better Call Saul/Season 06/better.call.saul.s06e01.mkv', 1400000000, 1680000000000],
  ['Mr. Robot/Season 01/mr.robot.s01e01.1080p.mkv', 2100000000, 1500000000000]
]

const music = [
  ['Ambient/clean bandit - symphony.flac', 38000000, 1690000000000],
  ['Ambient/Nimal Silva - ගීතය.mp3', 9500000, 1690000001000],
  ['Rock/queen - bohemian rhapsody.flac', 41000000, 1680000000000],
  ['Pop/random access memories.mp3', 12000000, 1670000000000]
]

const cats = [
  ['movies', 'demo-movies-bucket', movies],
  ['tv', 'demo-tv-bucket', tv],
  ['music', 'demo-music-bucket', music]
]

const insCat = db.prepare('INSERT INTO categories (name, slug, bucket, enabled, created_at, last_index_at, file_count, total_size) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
const insFile = db.prepare('INSERT INTO files (category_id, bucket, key, dir, name, ext, size, mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')

for (const [name, bucket, files] of cats) {
  const t = Date.now()
  const info = insCat.run(name, name, bucket, t, t, files.length, files.reduce((a, f) => a + f[1], 0))
  for (const [key, size, mtime] of files) {
    const i = key.lastIndexOf('/')
    const dir = i < 0 ? '' : key.slice(0, i)
    const fname = i < 0 ? key : key.slice(i + 1)
    const ext = (fname.match(/\.([a-z0-9]{1,8})$/) ?? [])[1] ?? ''
    insFile.run(info.lastInsertRowid, bucket, key, dir, fname, ext, size, mtime)
  }
}

setMeta('admin_password', scryptHash(process.env.ADMIN_PASSWORD))
console.log(`seeded ${cats.length} categories / ${movies.length + tv.length + music.length} files into ${dataDir}`)
console.log(`admin password: ${process.env.ADMIN_PASSWORD}`)
