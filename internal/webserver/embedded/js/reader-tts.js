import { ReaderToast } from './reader-toast.js'
import { Overlayer } from './foliate-js/overlayer.js'

const $ = document.querySelector.bind(document)

export class ReaderTTS {
    #reader
    #toast
    #ttsAudioQueue = []
    #ttsPrefetching = false
    #ttsAbortController = null
    #ttsTextQueue = []
    #ttsState = 'idle'
    #ttsPlayButton = null
    #ttsStopButton = null
    #ttsEngine = 'external'
    #ttsCachedSSML = null
    #ttsCurrentMark = '0'
    #ttsStalePrefetch = false
    #ttsClickRange = null
    #ttsPromiseCache = new Map()
    #ttsPrefetchAbortController = null

    constructor(reader) {
        this.#reader = reader
        this.#toast = new ReaderToast()
        this.#setupTTSControls()
    }

    get state() {
        return this.#ttsState
    }

    #setupTTSControls() {
        const controls = document.createElement('div')
        controls.id = 'tts-controls'

        const langBtns = document.createElement('div')
        langBtns.id = 'tts-lang-buttons'
        langBtns.innerHTML = `
            <button type="button" data-engine="external" class="tts-lang-btn">中文</button>
            <button type="button" data-engine="supertonic" class="tts-lang-btn">English</button>
        `
        langBtns.addEventListener('click', (e) => {
            const btn = e.target.closest('.tts-lang-btn')
            if (!btn) return
            const engine = btn.dataset.engine
            if (engine === this.#ttsEngine) return
            window.localStorage.setItem('reader-tts-engine', engine)
            this.#ttsEngine = engine
            this.#updateLangButtons()
            if (this.#ttsState !== 'idle') this.#stopTTS()
        })

        const playButton = document.createElement('button')
        playButton.id = 'tts-play'
        playButton.type = 'button'
        playButton.addEventListener('click', () => this.#toggleTTS())

        const stopButton = document.createElement('button')
        stopButton.id = 'tts-stop'
        stopButton.type = 'button'
        stopButton.setAttribute('aria-label', this.#reader.translations.tts_stop)
        stopButton.title = this.#reader.translations.tts_stop
        stopButton.innerHTML = '<svg class="icon" width="24" height="24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>'
        stopButton.addEventListener('click', () => this.#stopTTS())

        controls.append(langBtns, playButton, stopButton)
        $('#header-bar').insertBefore(controls, $('#menu-button'))

        this.#ttsPlayButton = playButton
        this.#ttsStopButton = stopButton
        this.#ttsEngine = window.localStorage.getItem('reader-tts-engine') || 'external'
        this.#updateLangButtons()
        this.#updateTTSButtons()
    }

    #updateLangButtons() {
        document.querySelectorAll('.tts-lang-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.engine === this.#ttsEngine)
        })
    }

    #updateTTSButtons() {
        if (!this.#ttsPlayButton || !this.#ttsStopButton) return
        const isLoading = this.#ttsState === 'loading'
        const isPlaying = this.#ttsState === 'playing'
        const isPaused = this.#ttsState === 'paused'

        const playLabel = isPlaying
            ? this.#reader.translations.tts_pause
            : isPaused ? this.#reader.translations.tts_resume : this.#reader.translations.tts_play

        this.#ttsPlayButton.disabled = isLoading
        this.#ttsPlayButton.setAttribute('aria-label', isLoading ? this.#reader.translations.tts_loading : playLabel)
        this.#ttsPlayButton.title = isLoading ? this.#reader.translations.tts_loading : playLabel
        this.#ttsPlayButton.innerHTML = isLoading
            ? '<svg class="icon tts-loading-icon" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>'
            : isPlaying
                ? '<svg class="icon" width="24" height="24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
                : '<svg class="icon" width="24" height="24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'

        this.#ttsStopButton.disabled = this.#ttsState === 'idle'
    }

    async #toggleTTS() {
        if (this.#ttsState === 'playing') {
            this.#ttsState = 'paused'
            this.#updateTTSButtons()
            this.#ttsAudioQueue[0]?.audio.pause()
            return
        }

        if (this.#ttsState === 'paused') {
            try {
                this.#ttsState = 'playing'
                this.#updateTTSButtons()
                this.#ttsAudioQueue[0]?.audio.play().catch(err => {
                    console.error('Error resuming TTS audio:', err)
                    this.#toast.show('warning', this.#reader.translations.tts_unavailable)
                    this.#stopTTS()
                })
            } catch (error) {
                console.error('Error resuming TTS:', error)
                this.#toast.show('warning', this.#reader.translations.tts_unavailable)
                this.#stopTTS()
            }
            return
        }

        await this.#playTTSSegment('fromCurrent')
    }

    #stopTTS() {
        this.#ttsAbortController?.abort()
        this.#ttsAbortController = null
        this.#clearTTSAudio()
        this.#ttsTextQueue = []
        this.#ttsCachedSSML = null
        this.#ttsStalePrefetch = false
        this.#clearTTSHighlight()
        this.#ttsState = 'idle'
        this.#updateTTSButtons()
        this.#reader.view?.focus()
    }

    #clearTTSAudio() {
        for (const item of this.#ttsAudioQueue) {
            item.audio.pause()
            item.audio.src = ''
            URL.revokeObjectURL(item.url)
        }
        this.#ttsAudioQueue = []
        this.#ttsPrefetchAbortController?.abort()
        this.#ttsPrefetchAbortController = null
        this.#ttsPromiseCache.clear()
    }

    async #playTTSSegment(mode) {
        if (!this.#reader.view) return

        this.#ttsAbortController?.abort()
        if (mode !== 'next') {
            this.#clearTTSAudio()
        } else {
            this.#ttsAudioQueue = []
        }
        this.#ttsAbortController = new AbortController()
        this.#ttsState = 'loading'
        this.#updateTTSButtons()

        try {
            await this.#reader.view.initTTS('sentence')

            const origHighlight = this.#reader.view.tts.highlight
            this.#reader.view.tts.highlight = (range) => {
                try {
                    if (origHighlight) origHighlight(range)
                    this.#ttsHighlightRange(range)
                } catch { /* ignore */ }
            }

            const item = await this.#nextTTSText(mode)
            if (!item) {
                this.#toast.show('info', this.#reader.translations.tts_no_text)
                this.#stopTTS()
                return
            }
            console.log("tts text: ", item.text)
            let promise = this.#ttsPromiseCache.get(item.text)
            if (!promise) {
                if (!this.#ttsPrefetchAbortController) {
                    this.#ttsPrefetchAbortController = new AbortController()
                }
                promise = this.#fetchSpeech(item.text, this.#ttsPrefetchAbortController.signal)
                this.#ttsPromiseCache.set(item.text, promise)
            }
            const blob = await promise
            await this.#playAudioBlob(blob, item.mark)
        } catch (error) {
            if (error.name === 'AbortError') return
            console.error('Error playing TTS:', error)
            this.#toast.show('warning', this.#reader.translations.tts_unavailable)
            this.#stopTTS()
        }
    }

    async #playAudioBlob(blob, mark) {
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audio.preload = 'auto'

        const queueItem = { audio, url, mark }
        this.#ttsAudioQueue.push(queueItem)

        audio.addEventListener('ended', () => {
            if (this.#ttsState !== 'playing') return

            const finished = this.#ttsAudioQueue.shift()
            finished.audio.src = ''
            URL.revokeObjectURL(finished.url)

            const next = this.#ttsAudioQueue[0]
            if (next && next.audio.readyState >= HTMLAudioElement.HAVE_CURRENT_DATA) {
                this.#ttsState = 'playing'
                this.#updateTTSButtons()
                try { this.#reader.view?.tts?.setMark?.(next.mark) } catch {}
                this.#replenishPrefetch()
                next.audio.play().catch(err => {
                    console.error('Error playing next audio:', err)
                    this.#toast.show('warning', this.#reader.translations.tts_unavailable)
                    this.#stopTTS()
                })
            } else {
                this.#playTTSSegment('next')
            }
        })

        audio.addEventListener('error', (ev) => {
            if (ev.target !== this.#ttsAudioQueue[0]?.audio) return
            this.#toast.show('warning', this.#reader.translations.tts_unavailable)
            this.#stopTTS()
        })

        this.#ttsState = 'playing'
        this.#updateTTSButtons()
        await audio.play()
        try { this.#reader.view?.tts?.setMark?.(queueItem.mark) } catch {}

        this.#replenishPrefetch()
    }

    async #replenishPrefetch() {
        if (new URLSearchParams(window.location.search).get('mode') === 'video') return
        if (this.#ttsPrefetching) return
        this.#ttsPrefetching = true

        const TARGET = 5
        try {
            while (this.#ttsAudioQueue.length < TARGET && this.#ttsState === 'playing') {
                // 解决语音与高亮不同步Bug：限制预取跨越段落(block)边界。
                // 只有当当前段落的句子完全播放完毕后，才加载下一段落。
                // 这样能确保 tts 内部的 ranges 缓存与当前播放段落完全吻合，避免高亮跑偏。
                if (this.#ttsTextQueue.length === 0) {
                    break
                }
                const item = this.#ttsTextQueue.shift()
                if (!item) break

                const blob = await this.#fetchSpeech(item.text, new AbortController().signal)
                if (this.#ttsState !== 'playing') break

                const url = URL.createObjectURL(blob)
                const audio = new Audio(url)
                audio.preload = 'auto'

                audio.addEventListener('ended', () => {
                    if (this.#ttsState !== 'playing') return
                    const finished = this.#ttsAudioQueue.shift()
                    if (finished) {
                        finished.audio.src = ''
                        URL.revokeObjectURL(finished.url)
                    }
                    const next = this.#ttsAudioQueue[0]
                    if (next && next.audio.readyState >= HTMLAudioElement.HAVE_CURRENT_DATA) {
                        this.#ttsState = 'playing'
                        this.#updateTTSButtons()
                        try { this.#reader.view?.tts?.setMark?.(next.mark) } catch {}
                        this.#replenishPrefetch()
                        next.audio.play().catch(err => {
                            console.error('Error playing next audio:', err)
                            this.#toast.show('warning', this.#reader.translations.tts_unavailable)
                            this.#stopTTS()
                        })
                    } else {
                        this.#playTTSSegment('next')
                    }
                })

                audio.addEventListener('error', (ev) => {
                    if (ev.target !== this.#ttsAudioQueue[0]?.audio) return
                    this.#toast.show('warning', this.#reader.translations.tts_unavailable)
                    this.#stopTTS()
                })

                this.#ttsAudioQueue.push({ audio, url, mark: item.mark })

                await Promise.race([
                    new Promise(resolve => {
                        audio.addEventListener('canplaythrough', resolve, { once: true })
                        audio.addEventListener('error', resolve, { once: true })
                    }),
                    new Promise(resolve => setTimeout(resolve, 2000))
                ])
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                this.#ttsStalePrefetch = true
            }
        } finally {
            this.#ttsPrefetching = false
        }
    }

    async #fetchSpeech(input, signal) {
        const res = await fetch('/tts/speech', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input, engine: this.#ttsEngine }),
            signal,
        })
        if (!res.ok) throw new Error(`TTS request failed: ${res.status}`)
        return res.blob()
    }

    #extractSegmentsFromSSML(ssml) {
        if (!ssml) return []
        try {
            const segments = []
            // 用正则精准、极速且100%容错地提取 <mark name="x"/> 以及其后面的文本段（直到下一个 mark 或 结束标签）
            // 完全免除了 DOMParser XML 解析出错（如 undefined HTML entity 等）带来的解析中断
            const regex = /<mark\s+name="([^"]+)"\s*\/?>([^<]*(?:<(?!mark\b)[^>]*>[^<]*)*)/gi
            let match
            while ((match = regex.exec(ssml)) !== null) {
                const mark = match[1]
                // 剥离文本中可能残留的其他 XML/HTML 标签（例如 <emphasis>、<phoneme> 等）
                let text = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
                if (text) {

                  // 1. 过滤单纯的脚注、角标、页码 (例如: "5", "[5]", "(12)")
                  const isFootnoteOrPageNum = /^[\[\(\{【（]?\s*\d+\s*[\]\)\}】）]?$/.test(text)
                  if (isFootnoteOrPageNum) {
                      // 打印日志方便你调试，看看它抓到了什么
                      console.log(`[TTS 过滤角标/页码]: ${text}`)
                      continue // 跳过，不塞入队列
                  }

                  // 2. 清洗句子内部的中英文括号内容
                  // 匹配模式: (...)、[...]、{...}、[...]、(...)、【...】
                  // 使用循环确保能嵌套或连续清除多组括号，比如 "A (B) C (D)" -> "A C"
                  const bracketRegex = /[（(\[{\【][^）)\]}\】]*[）)\]}\】]/g
                  if (bracketRegex.test(text)) {
                      const originalText = text
                      text = text.replace(bracketRegex, '').replace(/\s+/g, ' ').trim()
                      console.log(`[TTS 括号清洗]: "${originalText}" -> "${text}"`)
                  }

                  // final. 检查清洗括号后，句子是否被掏空了 (例如原本是 "(See above)"，删完括号变空字符串了)
                  if (!text) {
                      continue
                  }
                  segments.push({ mark, text })
                }
            }
            return segments
        } catch (e) {
            console.error('Error parsing SSML segments:', e)
            return []
        }
    }

    async #nextTTSText(mode) {
        while (!this.#ttsTextQueue.length) {
            const ssml = await this.#nextTTSSSML(mode)
            mode = 'next'
            if (!ssml) {
                if (!await this.#goToNextTTSSection()) {
                    return null
                }
                continue
            }
            const segments = this.#extractSegmentsFromSSML(ssml)
            console.log("segments: ",segments)
            if (segments.length) {
                this.#ttsTextQueue = segments
            } else {
                const text = this.#textFromSSML(ssml)
                if (text) {
                    this.#ttsTextQueue = this.#splitTTSText(text).map(t => ({ mark: '0', text: t }))
                } else if (!await this.#goToNextTTSSection()) {
                    return null
                }
            }
            this.#prefetchTextQueue(this.#ttsTextQueue)
        }
        return this.#ttsTextQueue.shift()
    }

    async #nextTTSSSML(mode) {
        let ssml
        if (this.#ttsClickRange) {
            ssml = await this.#reader.view.tts?.from(this.#ttsClickRange)
            this.#ttsClickRange = null
            this.#ttsStalePrefetch = false
            this.#ttsCachedSSML = null
        } else if (mode === 'next') {
            if (this.#ttsStalePrefetch) {
                ssml = this.#ttsCachedSSML
                this.#ttsStalePrefetch = false
                this.#ttsCachedSSML = null
            } else {
                ssml = await this.#reader.view.tts?.next()
                this.#ttsCachedSSML = ssml
            }
        } else {
            ssml = this.#reader.view.lastLocation?.range
                ? await this.#reader.view.tts?.from(this.#reader.view.lastLocation.range)
                : await this.#reader.view.tts?.start()
            this.#ttsStalePrefetch = false
            this.#ttsCachedSSML = null
        }
        if (ssml) {
            try {
                // 用正则直接、安全地匹配出第一个 mark 的 name，完美避开 XML 校验报错
                const match = /<mark\s+name="([^"]+)"\s*\/?>/i.exec(ssml)
                if (match && match[1]) {
                    this.#ttsCurrentMark = match[1]
                }
            } catch { /* ignore */ }
        }
        return ssml
    }

    #prefetchTextQueue(segments) {
        if (new URLSearchParams(window.location.search).get('mode') !== 'video') return
        console.log(`[TTS Parallel Prefetch] Prefetching ${segments.length} sentences in parallel...`)
        
        if (!this.#ttsPrefetchAbortController) {
            this.#ttsPrefetchAbortController = new AbortController()
        }
        const signal = this.#ttsPrefetchAbortController.signal
        
        for (const item of segments) {
            if (!this.#ttsPromiseCache.has(item.text)) {
                const promise = this.#fetchSpeech(item.text, signal).catch(err => {
                    const isAbort = err.name === 'AbortError' || err.message?.includes('abort') || err.message?.includes('Abort')
                    if (!isAbort) {
                        console.error('[TTS Parallel Prefetch] Error:', err)
                    }
                    this.#ttsPromiseCache.delete(item.text)
                    throw err
                })
                this.#ttsPromiseCache.set(item.text, promise)
            }
        }
    }

    async #goToNextTTSSection() {
        const currentIndex = this.#reader.view.renderer?.getContents?.()?.[0]?.index
        const sections = this.#reader.view.book?.sections ?? []
        if (typeof currentIndex !== 'number') return false

        for (let index = currentIndex + 1; index < sections.length; index++) {
            if (sections[index]?.linear === 'no') continue
            await this.#reader.view.goTo(index)
            this.#reader.view.tts = null
            await this.#reader.view.initTTS('sentence')
            return true
        }
        return false
    }

    #splitTTSText(text) {
        const maxLength = 90
        text = this.#cleanTTSText(text)
        const parts = text.match(/[^。！？!?；;.]+[。！？!?；;.」』”’）)]*/gu) ?? [text]
        const chunks = []

        for (const part of parts.map(part => part.trim()).filter(Boolean)) {
            if (part.length > maxLength) {
                chunks.push(...this.#splitLongTTSSentence(part, maxLength))
            } else {
                chunks.push(part)
            }
        }
        return chunks
            .map(chunk => this.#normalizeTTSPunctuation(chunk))
            .filter(Boolean)
    }

    #splitLongTTSSentence(text, maxLength) {
        const parts = text
            .split(/(?<=[；;：:、])\s*/u)
            .map(part => part.trim())
            .filter(Boolean)
        const chunks = []
        let current = ''

        for (const part of parts.length ? parts : [text]) {
            if (part.length > maxLength) {
                if (current) {
                    chunks.push(current)
                    current = ''
                }
                let remaining = part
                while (remaining.length > maxLength) {
                    let splitAt = remaining.lastIndexOf(' ', maxLength)
                    if (splitAt <= 0) splitAt = maxLength
                    chunks.push(remaining.slice(0, splitAt))
                    remaining = remaining.slice(splitAt).trim()
                }
                if (remaining) current = remaining
            } else if ((current + (current ? ' ' : '') + part).length > maxLength) {
                chunks.push(current)
                current = part
            } else {
                current += (current ? ' ' : '') + part
            }
        }
        if (current) chunks.push(current)
        return chunks
    }

    #cleanTTSText(text) {
        return text
            .replace(/[［\[]\s*\d+(?:\s*[-,，、]\s*\d+)*\s*[］\]]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
    }

    #normalizeTTSPunctuation(text) {
        return text
            .replaceAll('。', '.')
            .replaceAll('？', '?')
            .replaceAll('！', '!')
            .replaceAll('，', ',')
            .replaceAll('、', ',')
            .replaceAll('；', ';')
            .replaceAll('：', ':')
            .replaceAll('“', '"')
            .replaceAll('”', '"')
            .replaceAll('‘', "'")
            .replaceAll('’', "'")
            .replaceAll('（', '(')
            .replaceAll('）', ')')
            .replaceAll('【', '[')
            .replaceAll('】', ']')
            .replaceAll('《', '<')
            .replaceAll('》', '>')
            .replaceAll('—', '-')
            .replaceAll('……', '...')
            .replace(/\s+/g, ' ')
            .trim()
    }

    #ttsHighlightRange(range) {
        try {
            const content = this.#reader.view.renderer?.getContents?.()?.[0]
            const overlayer = content?.doc?.overlayer
            if (!overlayer) return
            overlayer.delete('tts-highlight')
            overlayer.add('tts-highlight', range, Overlayer.highlight, { color: 'rgba(255, 230, 0, 0.4)' })
        } catch { /* ignore */ }
    }

    #clearTTSHighlight() {
        try {
            const content = this.#reader.view.renderer?.getContents?.()?.[0]
            content?.doc?.overlayer?.delete('tts-highlight')
        } catch { /* ignore */ }
    }

    #textFromSSML(ssml) {
        if (!ssml) return ''
        // 用正则高效安全地剥离所有 XML 标签，提取干净的纯文本内容，避开 parsererror 导致的解析失败
        return ssml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    }

    onLoad(doc) {
        doc.addEventListener('click', e => {
            // 解决冲突1：如果点击了链接(a)、按钮(button)或交互按钮，直接忽略，不干扰原有点击逻辑
            if (e.target.closest('a') || e.target.closest('button') || e.target.closest('[role="button"]')) {
                return
            }

            const contents = this.#reader.view.renderer?.getContents?.()?.[0]
            const iframeRect = contents?.iframe?.getBoundingClientRect()
            if (!iframeRect) return

            const x = e.clientX
            const y = e.clientY

            let caretRange
            if (doc.caretRangeFromPoint) {
                caretRange = doc.caretRangeFromPoint(x, y)
            } else if (doc.caretPositionFromPoint) {
                const position = doc.caretPositionFromPoint(x, y)
                if (position) {
                    caretRange = doc.createRange()
                    caretRange.setStart(position.offsetNode, position.offset)
                    caretRange.setEnd(position.offsetNode, position.offset)
                }
            }

            // 解决冲突2：只有点击在真正的文本节点上才触发跳转，过滤点击空白边距、段落间隙或图片等误触
            if (caretRange && caretRange.startContainer.nodeType === Node.TEXT_NODE) {
                // 确保点击的不是纯空白字符
                if (!caretRange.startContainer.textContent.trim()) return

                this.#ttsClickRange = caretRange
                // 仅 in TTS 活跃（正在播放或暂停）时，点击文本才执行跳转播放，避免闲置时误点触发
                if (this.#ttsState !== 'idle') {
                    this.#stopTTS()
                    this.#playTTSSegment('fromCurrent')
                }
            }
        })
    }

    onRelocate(detail) {
        // 解决 RangeError: Maximum call stack size exceeded 报错：
        // 在朗读过程中，tts.setMark(mark) 会触发 highlight(range) 回调，进而执行 Paginator.scrollToAnchor 滚动视口以显示高亮。
        // 而 Paginator 滚动视口会同步触发 scroll/relocate 事件，如果再次在 onRelocate 中调用 setMark(mark)，
        // 就会陷入死循环（setMark -> highlight -> scroll -> relocate -> setMark），最终导致调用栈溢出崩溃。
        // 由于 Foliate 内置的 Overlayer 在视口滚动或重排时会自动重绘高亮，因此在此处调用 setMark 是冗余且危险的。我们安全地将其置为空函数。
    }
}
