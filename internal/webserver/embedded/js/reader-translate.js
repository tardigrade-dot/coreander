export class ReaderTranslate {
    #reader
    #doc = null
    #isTranslated = false
    #translateBtn = null
    #abortController = null
    #isTranslating = false

    constructor(reader) {
        this.#reader = reader
        this.#setupTranslateButton()
    }

    onLoad(doc) {
        this.#doc = doc
        if (this.#isTranslated) {
            this.translateSection()
        }
    }

    // Safely and dynamically retrieve the active document from Foliate's view renderer
    get activeDoc() {
        if (this.#doc) return this.#doc
        try {
            return this.#reader.view?.renderer?.getContents?.()?.[0]?.doc || null
        } catch {
            return null
        }
    }

    #setupTranslateButton() {
        const translateBtn = document.createElement('button')
        translateBtn.id = 'translate-btn'
        translateBtn.type = 'button'
        translateBtn.title = 'Translate to Chinese'
        translateBtn.setAttribute('aria-label', 'Translate to Chinese')
        
        // Premium SVG Translate Icon
        translateBtn.innerHTML = `
            <svg class="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 8l6 6"></path>
                <path d="M4 14h6.5"></path>
                <path d="M2 18h11"></path>
                <path d="M12 5h8"></path>
                <path d="M16 2v6"></path>
                <path d="M14 18l4-11 4 11"></path>
                <path d="M15 14h6"></path>
            </svg>
        `
        translateBtn.addEventListener('click', () => this.toggleTranslation())
        
        const menuButton = document.getElementById('menu-button')
        if (menuButton) {
            menuButton.parentNode.insertBefore(translateBtn, menuButton)
        }
        this.#translateBtn = translateBtn
    }

    toggleTranslation() {
        if (this.#isTranslated) {
            this.#isTranslated = false
            this.cancelTranslation()
            this.removeTranslations()
            this.#updateButtonState()
        } else {
            this.#isTranslated = true
            this.translateSection()
        }
    }

    cancelTranslation() {
        if (this.#abortController) {
            this.#abortController.abort()
            this.#abortController = null
        }
        this.#isTranslating = false
    }

    removeTranslations() {
        const doc = this.activeDoc
        if (!doc) return
        const trans = doc.querySelectorAll('.translation')
        trans.forEach(el => el.remove())
    }

    async translateText(text) {
        this.#abortController = new AbortController()
        
        try {
            const response = await fetch('/translate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ text }),
                signal: this.#abortController.signal
            })
            if (!response.ok) {
                throw new Error('Translation request failed')
            }
            const data = await response.json()
            return data.translation
        } catch (err) {
            if (err.name === 'AbortError') {
                return null
            }
            console.error('Translation error:', err)
            throw err
        }
    }

    async translateSection() {
        const doc = this.activeDoc
        if (!doc) return
        if (this.#isTranslating) {
            this.cancelTranslation()
        }
        
        this.#isTranslating = true
        this.#updateButtonState()
        
        const paragraphs = Array.from(doc.querySelectorAll('p'))
        
        for (const p of paragraphs) {
            if (!this.#isTranslated) break
            
            const next = p.nextElementSibling
            if (next && next.classList.contains('translation')) {
                next.style.display = ''
                continue
            }
            
            const text = p.textContent.trim()
            if (!text || text.length < 2) continue
            
            try {
                const translation = await this.translateText(text)
                if (translation && this.#isTranslated) {
                    const transPara = doc.createElement('p')
                    transPara.className = 'translation'
                    transPara.textContent = translation
                    p.insertAdjacentElement('afterend', transPara)
                }
            } catch (err) {
                console.error('Failed to translate paragraph:', err)
            }
        }
        
        this.#isTranslating = false
        this.#updateButtonState()
    }

    #updateButtonState() {
        if (!this.#translateBtn) return
        this.#translateBtn.classList.toggle('active', this.#isTranslated)
        
        if (this.#isTranslating) {
            this.#translateBtn.title = 'Translating...'
            this.#translateBtn.style.opacity = '0.6'
        } else {
            this.#translateBtn.title = this.#isTranslated ? 'Show original text' : 'Translate to Chinese'
            this.#translateBtn.style.opacity = ''
        }
    }
}
