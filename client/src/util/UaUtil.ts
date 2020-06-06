namespace UaUtil {
    /**
     * iPad スクリーン解像度定義
     */
    const IPAD_SCREENS = {
        1024: 768,
        1080: 810,
        1112: 834,
        1194: 834,
        1366: 1024,
        2048: 1536,
        2160: 1620,
        2224: 1668,
        2388: 1668,
        2732: 2048,
    };

    /**
     * UA が iOS か判定
     * @return boolean
     */
    export const isiOS = (): boolean => {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) || isiPadOS();
    };

    /**
     * UA が iPhone か判定
     */
    export const isiPhone = (): boolean => {
        return /iPhone|iphone/.test(navigator.userAgent);
    };

    /**
     * UA が iPadOS か判定
     */
    export const isiPadOS = (): boolean => {
        if (/Macintosh|macintosh/.test(navigator.userAgent) === false) {
            return false;
        }

        let width = 0;
        let height = 0;
        if (window.screen.width < window.screen.height) {
            width = window.screen.width;
            height = window.screen.height;
        } else {
            width = window.screen.height;
            height = window.screen.width;
        }

        return (<any>IPAD_SCREENS)[height] === width;
    };

    /**
     * UA が Android か判定
     * @return boolean
     */
    export const isAndroid = (): boolean => {
        return /Android|android/.test(navigator.userAgent);
    };

    /**
     * UA が Edge か判定
     * @return boolean
     */
    export const isEdge = (): boolean => {
        return /Edge|edge/.test(navigator.userAgent);
    };

    /**
     * UA が IE か判定
     * @return boolean
     */
    export const isIE = (): boolean => {
        return /msie|MSIE/.test(navigator.userAgent) || /Trident/.test(navigator.userAgent);
    };

    /**
     * UA が Chrome か判定
     * @return boolean
     */
    export const isChrome = (): boolean => {
        return /chrome|Chrome/.test(navigator.userAgent);
    };

    /**
     * UA が Firefox か判定
     * @return boolean
     */
    export const isFirefox = (): boolean => {
        return /firefox|Firefox/.test(navigator.userAgent);
    };

    /**
     * UA が Safari か判定
     * @return boolean
     */
    export const isSafari = (): boolean => {
        return /safari|Safari/.test(navigator.userAgent) && !isChrome();
    };

    /**
     * UA が Safari 10+ か判定
     * @return boolean
     */
    export const isSafari10OrLater = (): boolean => {
        return isSafari() && /Version\/1\d/i.test(navigator.userAgent);
    };

    /**
     * UA が Mobile か判定
     * @return boolean
     */
    export const isMobile = (): boolean => {
        return /Mobile|mobile/.test(navigator.userAgent);
    };

    /**
     * UA が macOS か判定
     * @return boolean
     */
    export const isMac = (): boolean => {
        return /Macintosh|macintosh/.test(navigator.userAgent) && isiPadOS() === false;
    };

    /**
     * UA が Windows か判定
     * @return boolean
     */
    export const isWindows = (): boolean => {
        return /Windows|windows/.test(navigator.userAgent);
    };
}

export default UaUtil;