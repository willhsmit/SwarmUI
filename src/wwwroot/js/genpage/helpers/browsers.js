
/** Helper utilities for browsers. */
class BrowserUtil {
    /**
     * Make any visible images within a container actually load now.
     */
    makeVisible(elem) {
        let elementsToLoad = Array.from(elem.querySelectorAll('.lazyload')).filter(e => {
            let top = e.getBoundingClientRect().top;
            return top != 0 && top < window.innerHeight + 512; // Note top=0 means not visible
        });
        for (let subElem of elementsToLoad) {
            subElem.classList.remove('lazyload');
            if (subElem.tagName == 'IMG') {
                if (!subElem.dataset.src) {
                    continue;
                }
                subElem.src = subElem.dataset.src;
                delete subElem.dataset.src;
            }
            else if (subElem.classList.contains('browser-section-loader')) {
                subElem.click();
                subElem.remove();
            }
        }
    }
}

let browserUtil = new BrowserUtil();

/**
 * Hack to attempt to prevent callback recursion.
 * In practice this seems to not work.
 * Either JavaScript itself or Firefox seems to really love tracking the stack and refusing to let go.
 * TODO: Guarantee it actually works so we can't stack overflow from file browsing ffs.
 */
class BrowserCallHelper {
    constructor(path, loadCaller) {
        this.path = path;
        this.loadCaller = loadCaller;
    }
    call() {
        this.loadCaller(this.path);
    }
}

/**
 * Part of a browser tree.
 */
class BrowserTreePart {
    constructor(name, children, hasOpened, isOpen, fileData = null, fullPath = '') {
        this.name = name;
        this.children = children;
        this.hasOpened = hasOpened;
        this.isOpen = isOpen;
        this.fileData = fileData;
        this.fullPath = fullPath.startsWith('/') ? fullPath.substring(1) : fullPath;
        this.clickme = null;
    }
}

/**
 * Class that handles browsable content sections (eg models list, presets list, etc).
 */
class GenPageBrowserClass {

    constructor(container, listFoldersAndFiles, id, defaultFormat, describe, select, extraHeader = '', defaultDepth = 3) {
        this.container = getRequiredElementById(container);
        this.listFoldersAndFiles = listFoldersAndFiles;
        this.id = id;
        this.format = localStorage.getItem(`browser_${this.id}_format`) || getCookie(`${id}_format`) || defaultFormat; // TODO: Remove the old cookie
        this.describe = describe;
        this.select = select;
        this.folder = '';
        this.selected = null;
        this.extraHeader = extraHeader;
        this.navCaller = this.navigate.bind(this);
        this.tree = new BrowserTreePart('', {}, false, true, null, '');
        this.depth = localStorage.getItem(`browser_${id}_depth`) || defaultDepth;
        this.filter = localStorage.getItem(`browser_${id}_filter`) || '';
        this.folderTreeVerticalSpacing = '0';
        this.splitterMinWidth = 100;
        this.everLoaded = false;
        this.showDisplayFormat = true;
        this.showDepth = true;
        this.showRefresh = true;
        this.showUpFolder = true;
        this.showFilter = true;
        this.folderTreeShowFiles = false;
        this.folderSelectedEvent = null;
        this.builtEvent = null;
        this.sizeChangedEvent = null;
        this.maxPreBuild = 512;
        this.chunksRendered = 0;
        this.rerenderPlanned = false;
        this.updatePendingSince = null;
        this.wantsReupdate = false;
        this.noContentUpdates = false;
        this.checkIsSmall();
    }

    /**
     * Checks if the window is small, setting isSmallWindow (mostly for mobile compat).
     */
    checkIsSmall() {
        let mobileDesktopLayout = localStorage.getItem('layout_mobileDesktop') || 'auto';
        this.isSmallWindow = mobileDesktopLayout == 'auto' ? window.innerWidth < 768 : mobileDesktopLayout == 'mobile';
    }

    /**
     * Schedules a rerender with a small delay.
     */
    planRerender(timeout) {
        if (this.rerenderPlanned) {
            return;
        }
        this.rerenderPlanned = true;
        setTimeout(() => {
            this.rerenderPlanned = false;
            this.rerender();
        }, timeout);
    }

    updateWithoutDup() {
        if (this.updatePendingSince && new Date().getTime() - this.updatePendingSince < 5000) {
            this.wantsReupdate = true;
            return;
        }
        this.update();
    }

    /**
     * Navigates the browser to a given folder path.
     */
    navigate(folder, callback = null) {
        this.chunksRendered = 0;
        this.folder = folder;
        this.selected = null;
        this.update(false, callback);
    }

    /**
     * Clicks repeatedly into a path to fully open it.
     */
    clickPath(path) {
        this.noContentUpdates = true;
        let tree = this.tree;
        if (!tree.isOpen) {
            tree.clickme(() => {
                this.clickPath(path);
            });
            return;
        }
        if (path.length == 0) {
            this.noContentUpdates = false;
            this.rerender();
            return;
        }
        let split = path.split('/');
        for (let part of split) {
            if (part == '') {
                continue;
            }
            if (!(part in tree.children)) {
                this.noContentUpdates = false;
                this.rerender();
                return;
            }
            tree = tree.children[part];
            if (!tree.isOpen) {
                tree.clickme(() => {
                    this.clickPath(path);
                });
                return;
            }
        }
        this.noContentUpdates = false;
        this.rerender();
    }

    /**
     * Refreshes the browser view from source.
     */
    refresh() {
        refreshParameterValues(true, () => {
            this.chunksRendered = 0;
            let path = this.folder;
            this.folder = '';
            let depth = this.depth;
            this.noContentUpdates = true;
            this.update(true, () => {
                this.clickPath(path);
            });
        });
    }

    /**
     * Updates/refreshes the browser view.
     */
    update(isRefresh = false, callback = null) {
        this.updatePendingSince = new Date().getTime();
        if (isRefresh) {
            this.tree = new BrowserTreePart('', {}, false, null, null, '');
            this.contentDiv.scrollTop = 0;
        }
        let folder = this.folder;
        this.listFoldersAndFiles(folder, isRefresh, (folders, files) => {
            this.build(folder, folders, files);
            this.updatePendingSince = null;
            if (callback) {
                setTimeout(() => callback(), 100);
            }
            if (this.wantsReupdate) {
                this.wantsReupdate = false;
                this.update();
            }
        }, this.depth);
    }

    /**
     * Generates the path list span for the current path view, and returns it.
     */
    genPath(path, upButton) {
        let pathGen = createSpan(`${this.id}-path`, 'browser-path');
        if (path == '') {
            upButton.disabled = true;
            return pathGen;
        }
        let rootPathPrefix = 'Root/';
        let partial = '';
        for (let part of (rootPathPrefix + path).split('/')) {
            partial += part + '/';
            let span = document.createElement('span');
            span.className = 'path-list-part';
            span.innerText = part;
            let route = partial.substring(rootPathPrefix.length);
            let helper = new BrowserCallHelper(route, this.navCaller);
            span.onclick = helper.call.bind(helper);
            pathGen.appendChild(span);
            pathGen.appendChild(document.createTextNode('/'));
        }
        upButton.disabled = false;
        let above = path.split('/').slice(0, -1).join('/');
        let helper = new BrowserCallHelper(above, this.navCaller);
        upButton.onclick = helper.call.bind(helper);
        return pathGen;
    }

    /**
     * Updates tree tracker for the given path.
     */
    refillTree(path, folders, isFile = false) {
        if (path.endsWith('/')) {
            path = path.substring(0, path.length - 1);
        }
        if (path.startsWith('/')) {
            path = path.substring(1);
        }
        let otherFolders = folders.filter(f => f.includes('/'));
        if (otherFolders.length > 0) {
            let baseFolders = folders.filter(f => !f.includes('/'));
            this.refillTree(path, baseFolders, isFile);
            while (otherFolders.length > 0) {
                let folder = otherFolders[0];
                let slash = folder.indexOf('/');
                let base = folder.substring(0, slash + 1);
                let same = otherFolders.filter(f => f.startsWith(base)).map(f => f.substring(base.length));
                this.refillTree(`${path}/${base}`, same, isFile);
                otherFolders = otherFolders.filter(f => !f.startsWith(base));
            }
            return;
        }
        if (path == '') {
            let copy = Object.assign({}, this.tree.children);
            this.tree.children = {};
            for (let folder of folders) {
                this.tree.children[folder] = copy[folder] || new BrowserTreePart(folder, {}, isFile, false, isFile ? this.getFileFor(folder) : null, folder);
            }
            this.tree.hasOpened = true;
            return;
        }
        let tree = this.tree, parent = this.tree;
        let parts = path.split('/');
        for (let part of parts) {
            parent = tree;
            if (!(part in parent.children)) {
                parent.children[part] = new BrowserTreePart(part, {}, false, false, null, parent.fullPath + '/' + part);
            }
            tree = parent.children[part];
        }
        let lastName = parts[parts.length - 1];
        let copy = Object.assign({}, tree.children);
        tree = new BrowserTreePart(lastName, {}, true, tree.isOpen, null, tree.fullPath);
        parent.children[lastName] = tree;
        for (let folder of folders) {
            tree.children[folder] = copy[folder] || new BrowserTreePart(folder, {}, isFile, false, isFile ? this.getFileFor(tree.fullPath + '/' + folder) : null, tree.fullPath + '/' + folder);
        }
    }

    /**
     * Builds the element view of the folder tree.
     */
    buildTreeElements(container, path, tree, offset = 16, isRoot = true) {
        if (isRoot) {
            let spacer = createDiv(null, 'browser-folder-tree-spacer');
            spacer.style.height = this.folderTreeVerticalSpacing;
            container.appendChild(spacer);
        }
        let span = createSpan(`${this.id}-foldertree-${tree.name}`, 'browser-folder-tree-part');
        let trueOffset = offset;
        if (this.isSmallWindow) {
            trueOffset /= 2;
        }
        span.style.left = `${trueOffset}px`;
        span.innerHTML = `<span class="browser-folder-tree-part-symbol" data-issymbol="true"></span> ${escapeHtml(tree.name || 'Root')}`;
        span.dataset.path = path;
        container.appendChild(span);
        if ((Object.keys(tree.children).length == 0 && tree.hasOpened) || tree.fileData) {
            // Default: no class
        }
        else if (tree.isOpen) {
            span.classList.add('browser-folder-tree-part-open');
            let subContainer = createDiv(`${this.id}-foldertree-${tree.name}-container`, 'browser-folder-tree-part-container');
            for (let subTree of Object.values(tree.children)) {
                this.buildTreeElements(subContainer, `${path}${subTree.name}/`, subTree, offset + 16, false);
            }
            container.appendChild(subContainer);
        }
        else {
            span.classList.add('browser-folder-tree-part-closed');
        }
        let matchMe = this.selected || this.folder;
        if (matchMe == path || `${matchMe}/` == path) {
            span.classList.add('browser-folder-tree-part-selected');
        }
        if (tree.fileData) {
            span.onclick = (e) => {
                this.select(tree.fileData, null);
            };
            tree.clickme = (callback) => this.select(tree.fileData, callback);
        }
        else {
            let clicker = (isSymbol, callback) => {
                if (this.folderSelectedEvent) {
                    this.folderSelectedEvent(path);
                }
                tree.hasOpened = true;
                if (isSymbol) {
                    tree.isOpen = !tree.isOpen;
                }
                else {
                    tree.isOpen = true;
                }
                this.navigate(path, callback);
            };
            span.onclick = (e) => clicker(e.target.dataset.issymbol, null);
            tree.clickme = (callback) => clicker(false, callback);
        }
        tree.span = span;
    }

    /**
     * Fills the container with the content list.
     */
    buildContentList(container, files, before = null, startId = 0) {
        let id = startId;
        let maxBuildNow = this.maxPreBuild;
        if (startId == 0) {
            maxBuildNow += this.chunksRendered * Math.min(this.maxPreBuild / 2, 100);
            this.chunksRendered = 0;
        }
        else {
            this.chunksRendered++;
        }
        for (let i = 0; i < files.length; i++) {
            let file = files[i];
            id++;
            let desc = this.describe(file);
            if (this.filter && !desc.searchable.toLowerCase().includes(this.filter)) {
                continue;
            }
            if (i > maxBuildNow) {
                let remainingFiles = files.slice(i);
                while (remainingFiles.length > 0) {
                    let chunkSize = Math.min(this.maxPreBuild / 2, remainingFiles.length, 100);
                    let chunk = remainingFiles.splice(0, chunkSize);
                    let sectionDiv = createDiv(null, 'lazyload browser-section-loader');
                    sectionDiv.onclick = () => {
                        this.buildContentList(container, chunk, sectionDiv, id);
                    };
                    container.appendChild(sectionDiv);
                }
                break;
            }
            let div = createDiv(null, `${desc.className}`);
            let popoverId = `${this.id}-${id}`;
            if (desc.buttons.length > 0) {
                let menuDiv = createDiv(`popover_${popoverId}`, 'sui-popover sui_popover_model');
                for (let button of desc.buttons) {
                    let buttonElem;
                    if (button.href) {
                        buttonElem = document.createElement('a');
                        buttonElem.href = button.href;
                        if (button.is_download) {
                            buttonElem.download = '';
                        }
                    }
                    else {
                        buttonElem = document.createElement('div');
                    }
                    buttonElem.className = 'sui_popover_model_button';
                    buttonElem.innerText = button.label;
                    if (button.onclick) {
                        buttonElem.onclick = () => button.onclick(div);
                    }
                    menuDiv.appendChild(buttonElem);
                }
                if (before) {
                    container.insertBefore(menuDiv, before);
                }
                else {
                    container.appendChild(menuDiv);
                }
            }
            let img = document.createElement('img');
            img.addEventListener('click', () => {
                this.select(file, div);
            });
            div.appendChild(img);
            if (this.format.includes('Cards')) {
                div.className += ' model-block model-block-hoverable';
                if (this.format.startsWith('Small')) { div.classList.add('model-block-small'); }
                else if (this.format.startsWith('Big')) { div.classList.add('model-block-big'); }
                let textBlock = createDiv(null, 'model-descblock');
                textBlock.tabIndex = 0;
                textBlock.innerHTML = desc.description;
                div.appendChild(textBlock);
            }
            else if (this.format.includes('Thumbnails')) {
                div.className += ' image-block image-block-legacy';
                let factor = 8;
                if (this.format.startsWith('Big')) { factor = 15; div.classList.add('image-block-big'); }
                else if (this.format.startsWith('Giant')) { factor = 25; div.classList.add('image-block-giant'); }
                else if (this.format.startsWith('Small')) { factor = 5; div.classList.add('image-block-small'); }
                if (desc.aspectRatio) {
                    div.style.width = `${(desc.aspectRatio * factor) + 1}rem`;
                }
                else {
                    div.style.width = `${factor + 1}rem`;
                    img.addEventListener('load', () => {
                        let ratio = img.width / img.height;
                        div.style.width = `${(ratio * factor) + 1}rem`;
                    });
                }
                let textBlock = createDiv(null, 'image-preview-text');
                textBlock.innerText = desc.display || desc.name;
                if (this.format == "Small Thumbnails" || textBlock.innerText.length > 40) {
                    textBlock.classList.add('image-preview-text-small');
                }
                else if (textBlock.innerText.length > 20) {
                    textBlock.classList.add('image-preview-text-medium');
                }
                else {
                    textBlock.classList.add('image-preview-text-large');
                }
                div.appendChild(textBlock);
            }
            else if (this.format == 'List') {
                div.className += ' browser-list-entry';
                let textBlock = createSpan(null, 'browser-list-entry-text');
                textBlock.innerText = desc.display || desc.name;
                textBlock.addEventListener('click', () => {
                    this.select(file, div);
                });
                div.appendChild(textBlock);
            }
            else if (this.format == 'Details List') {
                img.style.width = '1.3rem';
                div.className += ' browser-details-list-entry';
                let detail_list = desc.detail_list;
                if (!detail_list) {
                    detail_list = [escapeHtml(desc.display || desc.name), desc.description.replaceAll('<br>', '&emsp;')];
                }
                let percent = 98 / detail_list.length;
                let imgAdj = 1.3 / detail_list.length;
                for (let detail of detail_list) {
                    let textBlock = createSpan(null, 'browser-details-list-entry-text');
                    textBlock.style.width = `calc(${percent}% - ${imgAdj}rem)`;
                    textBlock.innerHTML = detail;
                    textBlock.addEventListener('click', () => {
                        this.select(file, div);
                    });
                    div.appendChild(textBlock);
                }
            }
            if (desc.buttons.length > 0) {
                let menu = createDiv(null, 'model-block-menu-button');
                menu.innerHTML = '&#x2630;';
                menu.addEventListener('click', () => {
                    doPopover(popoverId);
                });
                div.appendChild(menu);
            }
            if (!this.format.includes('Cards')) {
                div.addEventListener('mouseenter', () => div.title = stripHtmlToText(desc.description), { once: true });
            }
            div.dataset.name = file.name;
            img.classList.add('lazyload');
            img.dataset.src = desc.image;
            if (desc.dragimage) {
                img.addEventListener('dragstart', (e) => {
                    chromeIsDumbFileHack(e.dataTransfer.files[0], desc.dragimage);
                    e.dataTransfer.clearData();
                    e.dataTransfer.setDragImage(img, 0, 0);
                    e.dataTransfer.setData('text/uri-list', desc.dragimage);
                });
            }
            if (before) {
                container.insertBefore(div, before);
            }
            else {
                container.appendChild(div);
            }
        }
        setTimeout(() => {
            browserUtil.makeVisible(container);
        }, 100);
    }

    /**
     * Triggers an immediate in-place rerender of the current browser view.
     */
    rerender() {
        if (this.lastPath != null) {
            this.build(this.lastPath, null, this.lastFiles);
        }
    }

    /**
     * Returns the file object for a given path.
     */
    getFileFor(path) {
        return this.lastFiles.find(f => f.name == path);
    }

    /**
     * Returns the visible element block for a given file name.
     */
    getVisibleEntry(name) {
        for (let child of this.contentDiv.children) {
            if (child.dataset.name == name) {
                return child;
            }
        }
        return null;
    }

    /**
     * Central call to build the browser content area.
     */
    build(path, folders, files) {
        this.checkIsSmall();
        if (path.endsWith('/')) {
            path = path.substring(0, path.length - 1);
        }
        let scrollOffset = 0;
        this.lastPath = path;
        if (folders) {
            this.refillTree(path, folders, false);
        }
        else if (folders == null && this.contentDiv) {
            scrollOffset = this.contentDiv.scrollTop;
        }
        if (files == null) {
            files = this.lastFiles;
        }
        this.lastFiles = files;
        if (files && this.folderTreeShowFiles) {
            this.refillTree(path, files.map(f => {
                let name = f.name.substring(path.length);
                if (name.startsWith('/')) {
                    name = name.substring(1);
                }
                return name;
            }), true);
        }
        let folderScroll = this.folderTreeDiv ? this.folderTreeDiv.scrollTop : 0;
        if (!this.hasGenerated) {
            this.hasGenerated = true;
            this.container.innerHTML = '';
            this.folderTreeDiv = createDiv(`${this.id}-foldertree`, 'browser-folder-tree-container');
            let folderTreeSplitter = createDiv(`${this.id}-splitter`, 'browser-folder-tree-splitter splitter-bar');
            this.headerBar = createDiv(`${this.id}-header`, 'browser-header-bar');
            this.fullContentDiv = createDiv(`${this.id}-fullcontent`, 'browser-fullcontent-container');
            this.container.appendChild(this.folderTreeDiv);
            this.container.appendChild(folderTreeSplitter);
            this.container.appendChild(this.fullContentDiv);
            let formatSelector = document.createElement('select');
            formatSelector.id = `${this.id}-format-selector`;
            formatSelector.title = 'Display format';
            formatSelector.className = 'browser-format-selector';
            for (let format of ['Cards', 'Small Cards', 'Big Cards', 'Thumbnails', 'Small Thumbnails', 'Big Thumbnails', 'Giant Thumbnails', 'List', 'Details List']) {
                let option = document.createElement('option');
                option.value = format;
                option.className = 'translate';
                option.innerText = translate(format);
                if (format == this.format) {
                    option.selected = true;
                }
                formatSelector.appendChild(option);
            }
            formatSelector.addEventListener('change', () => {
                this.format = formatSelector.value;
                localStorage.setItem(`browser_${this.id}_format`, this.format);
                this.updateWithoutDup();
            });
            if (!this.showDisplayFormat) {
                formatSelector.style.display = 'none';
            }
            let buttons = createSpan(`${this.id}-button-container`, 'browser-header-buttons', 
                `<button id="${this.id}_refresh_button" title="Refresh" class="refresh-button translate translate-no-text">&#x21BB;</button>\n`
                + `<button id="${this.id}_up_button" class="refresh-button translate translate-no-text" disabled autocomplete="off" title="Go back up 1 folder">&#x21d1;</button>\n`
                + `<span><span class="translate">Depth</span>: <input id="${this.id}_depth_input" class="depth-number-input translate translate-no-text" type="number" min="1" max="10" value="${this.depth}" title="Depth of subfolders to show" autocomplete="off"></span>\n`
                + `<div class="input_filter_container bottom_filter"><input id="${this.id}_filter_input" type="text" value="${this.filter}" title="Text filter, only show items that contain this text." rows="1" autocomplete="off" class="translate translate-no-text" placeholder="${translate('Filter...')}"><span class="clear_input_icon bottom_filter">&#x2715;</span></div>\n`
                + this.extraHeader);
            let inputArr = buttons.getElementsByTagName('input');
            let depthInput = inputArr[0];
            depthInput.addEventListener('change', () => {
                this.depth = depthInput.value;
                localStorage.setItem(`browser_${this.id}_depth`, this.depth);
                this.updateWithoutDup();
            });
            if (!this.showDepth) {
                depthInput.parentElement.style.display = 'none';
            }
            let clearFilterBtn = buttons.getElementsByClassName('clear_input_icon')[0];
            let filterInput = inputArr[1];
            filterInput.addEventListener('input', () => {
                this.filter = filterInput.value.toLowerCase();
                localStorage.setItem(`browser_${this.id}_filter`, this.filter);
                if (this.filter.length > 0) {
                    clearFilterBtn.style.display = 'block';
                }
                else {
                    clearFilterBtn.style.display = 'none';
                }
                setTimeout(() => {
                    this.updateWithoutDup();
                }, 1);
            });
            if (!this.showFilter) {
                filterInput.parentElement.style.display = 'none';
            }
            clearFilterBtn.addEventListener('click', () => {
                filterInput.value = '';
                filterInput.focus();
                filterInput.dispatchEvent(new Event('input'));
            });
            if (this.filter.length > 0) {
                clearFilterBtn.style.display = 'block';
            }
            let buttonArr = buttons.getElementsByTagName('button');
            let refreshButton = buttonArr[0];
            this.upButton = buttonArr[1];
            if (!this.showRefresh) {
                refreshButton.style.display = 'none';
            }
            if (!this.showUpFolder) {
                this.upButton.style.display = 'none';
            }
            this.headerBar.appendChild(formatSelector);
            this.headerBar.appendChild(buttons);
            refreshButton.onclick = this.refresh.bind(this);
            this.fullContentDiv.appendChild(this.headerBar);
            this.contentDiv = createDiv(`${this.id}-content`, 'browser-content-container');
            this.contentDiv.addEventListener('scroll', () => {
                browserUtil.makeVisible(this.contentDiv);
            });
            this.fullContentDiv.appendChild(this.contentDiv);
            this.barSpot = 0;
            let setBar = () => {
                let barSpot = this.barSpot;
                if (this.isSmallWindow) {
                    barSpot = 100; // TODO: Swipeable width
                }
                this.folderTreeDiv.style.width = `${barSpot}px`;
                this.fullContentDiv.style.width = `calc(100% - ${barSpot}px - 0.6rem)`;
                if (this.sizeChangedEvent) {
                    this.sizeChangedEvent();
                }
            }
            this.lastReset = () => {
                this.barSpot = parseInt(localStorage.getItem(`barspot_browser_${this.id}`) || convertRemToPixels(20));
                setBar();
            };
            this.lastReset();
            let isDrag = false;
            folderTreeSplitter.addEventListener('mousedown', (e) => {
                e.preventDefault();
                if (this.isSmallWindow) {
                    return;
                }
                isDrag = true;
            }, true);
            this.lastListen = (e) => {
                let offX = e.pageX - this.container.getBoundingClientRect().left;
                offX = Math.min(Math.max(offX, this.splitterMinWidth), window.innerWidth - 100);
                if (isDrag) {
                    this.barSpot = offX - 5;
                    localStorage.setItem(`barspot_browser_${this.id}`, this.barSpot);
                    setBar();
                }
            };
            this.lastListenUp = () => {
                isDrag = false;
            };
            document.addEventListener('mousemove', this.lastListen);
            document.addEventListener('mouseup', this.lastListenUp);
            genTabLayout.layoutResets.push(() => {
                localStorage.removeItem(`barspot_browser_${this.id}`);
                this.lastReset();
            });
        }
        else {
            this.folderTreeDiv.innerHTML = '';
            this.contentDiv.innerHTML = '';
            this.headerPath.remove();
            this.headerCount.remove();
        }
        this.headerPath = this.genPath(path, this.upButton);
        this.headerBar.appendChild(this.headerPath);
        this.headerCount = createSpan(null, 'browser-header-count');
        this.headerCount.innerText = files.length;
        this.headerBar.appendChild(this.headerCount);
        this.buildTreeElements(this.folderTreeDiv, '', this.tree);
        applyTranslations(this.headerBar);
        if (!this.noContentUpdates) {
            this.buildContentList(this.contentDiv, files);
            browserUtil.makeVisible(this.contentDiv);
            if (scrollOffset) {
                this.contentDiv.scrollTop = scrollOffset;
            }
            applyTranslations(this.contentDiv);
        }
        if (folderScroll) {
            this.folderTreeDiv.scrollTop = folderScroll;
        }
        this.everLoaded = true;
        if (this.builtEvent) {
            this.builtEvent();
        }
    }
}
