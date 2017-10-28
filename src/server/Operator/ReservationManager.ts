import * as path from 'path';
import * as fs from 'fs';
import Base from '../Base';
import * as apid from '../../../node_modules/mirakurun/api';
import Tuner from './Tuner';
import { SearchInterface, OptionInterface, EncodeInterface } from './RuleInterface';
import { ProgramsDBInterface } from '../Model/DB/ProgramsDB';
import { IPCServerInterface } from '../Model/IPC/IPCServer';
import { RulesDBInterface } from '../Model/DB/RulesDB';
import * as DBSchema from '../Model/DB/DBSchema';
import { ReserveProgram } from './ReserveProgramInterface';
import DateUtil from '../Util/DateUtil';
import CheckRule from '../Util/CheckRule';

interface ReserveAllId {
    reserves: ReserveAllItem[],
    conflicts: ReserveAllItem[],
    skips: ReserveAllItem[],
}

interface ReserveAllItem {
    programId: number,
    ruleId?: number,
}

interface ReserveLimit {
    reserves: ReserveProgram[];
    total: number;
}

interface ReservationManagerInterface {
    setTuners(tuners: apid.TunerDevice[]): void;
    getReserve(programId: apid.ProgramId): ReserveProgram | null;
    getReservesAll(limit?: number, offset?: number): ReserveProgram[];
    getReservesAllId(): ReserveAllId;
    getReserves(limit?: number, offset?: number): ReserveLimit;
    getConflicts(limit?: number, offset?: number): ReserveLimit;
    getSkips(limit?: number, offset?: number): ReserveLimit;
    cancel(id: apid.ProgramId): void;
    removeSkip(id: apid.ProgramId): Promise<void>;
    addReserve(programId: apid.ProgramId, encode?: EncodeInterface): Promise<void>;
    updateAll(): Promise<void>;
    updateRule(ruleId: number): Promise<void>;
    clean(): void;
}

/**
* ReservationManager
* 予約の管理を行う
* @throws ReservationManagerCreateError init を呼ばないと起こる
*/
class ReservationManager extends Base {
    private static instance: ReservationManager;
    private static inited: boolean = false;
    private isRunning: boolean = false;
    private programDB: ProgramsDBInterface;
    private rulesDB: RulesDBInterface;
    private ipc: IPCServerInterface;
    private reserves: ReserveProgram[] = []; //予約
    private tuners: Tuner[] = [];
    private reservesPath: string;

    public static init(programDB: ProgramsDBInterface, rulesDB: RulesDBInterface, ipc: IPCServerInterface) {
        if(ReservationManager.inited) { return; }
        ReservationManager.inited = true;
        this.instance = new ReservationManager(programDB, rulesDB, ipc);
        ReservationManager.inited = true;
    }

    public static getInstance(): ReservationManager {
        if(!ReservationManager.inited) {
            throw new Error('ReservationManagerCreateError');
        }

        return this.instance;
    }

    private constructor(programDB: ProgramsDBInterface, rulesDB: RulesDBInterface, ipc: IPCServerInterface) {
        super();
        this.programDB = programDB;
        this.rulesDB = rulesDB;
        this.ipc = ipc;
        this.reservesPath = this.config.getConfig().reserves || path.join(__dirname, '..', '..', '..', 'data', 'reserves.json');
        this.readReservesFile();
    }

    /**
    * チューナ情報をセット
    * @param tuners: TunerDevice[]
    */
    public setTuners(tuners: apid.TunerDevice[]): void {
        this.tuners = tuners.map((tuner) => {
            return new Tuner(tuner);
        });
    }

    /**
    * 指定した id の予約状態を取得する
    * @param programId: program id
    * @return ReserveProgram | null
    */
    public getReserve(programId: apid.ProgramId): ReserveProgram | null {
        for(let reserve of this.reserves) {
            if(reserve.program.id === programId) {
                return reserve;
            }
        }

        return null;
    }

    /**
    * すべての予約状態を取得する
    * @return ReserveProgram[]
    */
    public getReservesAll(limit?: number, offset: number = 0): ReserveProgram[] {
        if(typeof limit !== 'undefined') {
            return this.reserves.slice(offset, limit + offset);
        }
        return this.reserves;
    }

    /**
    * 予約の program id だけを取得する
    * @return ReserveAllId
    */
    public getReservesAllId(): ReserveAllId {
        let reserves: ReserveAllItem[] = [];
        let conflicts: ReserveAllItem[] = [];
        let skips: ReserveAllItem[] = [];

        this.reserves.forEach((reserve) => {
            let result: ReserveAllItem = {
                programId: reserve.program.id,
            }
            if(typeof reserve.ruleId !== 'undefined') {
                result.ruleId = reserve.ruleId;
            }

            if(reserve.isConflict) {
                conflicts.push(result);
            } else if(reserve.isSkip) {
                skips.push(result);
            } else {
                reserves.push(result);
            }
        });

        return {
            reserves: reserves,
            conflicts: conflicts,
            skips: skips,
        }
    }

    /**
    * 予約状態を取得する
    * @return ReserveProgram[]
    */
    public getReserves(limit?: number, offset: number = 0): ReserveLimit {
        let reserves = this.reserves.filter((reserve) => {
            return !reserve.isConflict && !reserve.isSkip;
        });

        return {
            reserves: typeof limit === 'undefined' ? reserves : reserves.slice(offset, limit + offset),
            total: reserves.length,
        };
    }

    /**
    * コンフリクト状態を取得する
    * @return ReserveProgram[]
    */
    public getConflicts(limit?: number, offset: number = 0): ReserveLimit {
        let reserves = this.reserves.filter((reserve) => {
            return reserve.isConflict;
        });

        return {
            reserves: typeof limit === 'undefined' ? reserves : reserves.slice(offset, limit + offset),
            total: reserves.length,
        };
    }

    /**
    * スキップを取得する
    * @return ReserveProgram[]
    */
    public getSkips(limit?: number, offset: number = 0): ReserveLimit {
        let reserves = this.reserves.filter((reserve) => {
            return reserve.isSkip;
        });

        return {
            reserves: typeof limit === 'undefined' ? reserves : reserves.slice(offset, limit + offset),
            total: reserves.length,
        };
    }

    /**
    * 予約削除(手動予約) or 予約スキップ(ルール予約)
    * @param id: program id
    * @throws ReservationManagerIsRunning 他で予約情報更新中の場合
    */
    public cancel(id: apid.ProgramId): void {
        if(this.isRunning) { throw new Error(ReservationManager.ReservationManagerIsRunningError); }
        this.isRunning = true;

        let needsUpdateAll = false;
        for(let i = 0; i < this.reserves.length; i++) {
            if(this.reserves[i].program.id === id) {
                if(this.reserves[i].isManual) {
                    //手動予約なら削除
                    this.reserves.splice(i, 1);
                    this.writeReservesFile();
                    this.log.system.info(`cancel reserve: ${ id }`);
                    needsUpdateAll = true;
                    break;
                } else {
                    //ルール予約ならスキップを有効化
                    this.reserves[i].isSkip = true;
                    // skip すれば録画されないのでコンフリクトはしない
                    this.reserves[i].isConflict = false;
                    this.writeReservesFile();
                    this.log.system.info(`add skip: ${ id }`);
                    needsUpdateAll = true;
                    break;
                }
            }
        }

        this.isRunning = false;
        if(needsUpdateAll) { this.updateAll(); }
    }

    /**
    * 予約対象から除外され状態を解除する
    * @param id: number program id
    * @throws ReservationManagerIsRunning 他で予約情報更新中の場合
    */
    public async removeSkip(id: apid.ProgramId): Promise<void> {
        if(this.isRunning) { throw new Error(ReservationManager.ReservationManagerIsRunningError); }
        this.isRunning = true;

        for(let i = 0; i < this.reserves.length; i++) {
            if(this.reserves[i].program.id === id) {
                this.reserves[i].isSkip = false;
                this.log.system.info(`remove skip: ${ id }`);

                this.isRunning = false;
                if(typeof this.reserves[i].ruleId !== 'undefined') {
                    this.updateRule(this.reserves[i].ruleId!);
                }
                break;
            }
        }
    }

    /**
    * 手動予約追加
    * @param programId: number program id
    * @return Promise<void>
    * @throws ReservationManagerAddFailed 予約に失敗
    */
    public async addReserve(programId: apid.ProgramId, encode: EncodeInterface | null = null): Promise<void> {
        if(this.isRunning) { throw new Error('ReservationManagerUpdateManualIsRunning'); }

        // encode option が正しいかチェック
        if(encode != null && !(new CheckRule().checkEncodeOption(encode))) {
            this.log.system.error('addReserve Failed');
            this.log.system.error('ReservationManager is Running');
            throw new Error('ReservationManagerAddFailed');
        }

        // 更新ロック
        this.isRunning = true;
        this.log.system.info(`addReserve: ${ programId }`);

        const finalize = () => { this.isRunning = false; }

        //番組情報を取得
        let programs: DBSchema.ProgramSchema[];
        try {
            programs = await this.programDB.findId(programId, true);
        } catch(err) {
            finalize();
            throw err;
        }

        // programId に該当する録画データがなかった
        if(programs.length === 0) {
            finalize();
            this.log.system.error(`program is not found: ${ programId }`);
            throw new Error('ProgramIsNotFound');
        }

        //追加する予約情報を生成
        let addReserve: ReserveProgram = {
            program: programs[0],
            isSkip: false,
            isManual: true,
            manualId: new Date().getTime(),
            isConflict: false,
        };
        if(encode != null) {
            addReserve.encodeOption = encode;
        }

        //追加する予約情報と重複する時間帯の予約済み番組情報を conflict, skip は除外して取得
        //すでに予約済みの場合はエラー
        let reserves: ReserveProgram[] = [];
        for(let reserve of this.reserves) {
            if(reserve.program.id == programId) {
                this.log.system.error(`program is reserves: ${ programId }`);
                finalize();
                throw new Error('ReservationManagerAddFailed');
            }

            // 該当する予約情報をコピー
            if(!reserve.isConflict
                && !reserve.isSkip
                && reserve.program.startAt <= addReserve.program.endAt
                && reserve.program.endAt >= addReserve.program.startAt
            ) {
                let r: any = {};
                Object.assign(r, reserve);
                reserves.push(r);
            }
        }

        // 予約情報を生成
        reserves.push(addReserve);
        const newReserves = this.createReserves(reserves);

        // conflict したかチェック
        for(let reserve of newReserves) {
            if(reserve.isConflict) {
                finalize();
                this.log.system.error(`program id conflict: ${ programId }`);
                throw new Error('ReservationManagerAddReserveConflict');
            }
        }

        // 保存
        this.reserves.push(addReserve);
        this.reserves.sort((a, b) => { return a.program.startAt - b.program.startAt });
        this.writeReservesFile();

        finalize();

        this.log.system.info(`success addReserve: ${ programId }`);
    }

    /**
    * すべての予約状態を更新
    * @return Promise<void> すでに実行中なら ReservationManagerUpdateIsRunning が発行される
    */
    public async updateAll(): Promise<void> {
        if(this.isRunning) { throw new Error(ReservationManager.ReservationManagerIsRunningError); }
        this.isRunning = true;

        this.log.system.info('updateAll start');

        // 手動, rule で該当する予約情報を取得
        let matches: ReserveProgram[] = [];
        // スキップ情報
        let skipIndex: { [key: number]: boolean } = {};

        // 手動予約の情報を追加する
        for(let reserve of this.reserves) {
            //スキップ情報を記録
            if(reserve.isSkip) { skipIndex[reserve.program.id] = reserve.isSkip; }

            // rule 予約はスルー
            if(!reserve.isManual || typeof reserve.manualId === 'undefined') { continue; }

            //手動予約情報を追加
            try {
                let programs = await this.programDB.findId(reserve.program.id, true);
                if(programs.length === 0) { continue; }
                reserve.program = programs[0];
                matches.push(reserve);
            } catch(err) {
                this.log.system.error('manual program search error');
                this.log.system.error(err);
                continue;
            }
        }

        // rule 予約の情報を追加する
        let rules = await this.rulesDB.findAll();
        for(let rule of rules) {
            if(!rule.enable) { continue; }

            // 番組情報を取得
            let programs: DBSchema.ProgramSchema[];
            try {
                programs = await this.programDB.findRule(this.createSearchOption(rule!));
            } catch(err) {
                this.log.system.error('rule program search error');
                this.log.system.error(err);
                continue;
            }

            //番組情報を保存
            let encode = this.createEncodeOption(rule);
            let ruleOption = this.createOption(rule);
            programs.forEach((program) => {
                let data: ReserveProgram = {
                    program: program,
                    ruleId: rule.id,
                    ruleOption: ruleOption,
                    isSkip: typeof skipIndex[program.id] === 'undefined' ? false : skipIndex[program.id],
                    isManual: false,
                    isConflict: false,
                };
                if(encode !== null) {
                    data.encodeOption = encode;
                }
                matches.push(data);
            });
        }

        // 予約情報を生成
        this.reserves = this.createReserves(matches);
        this.writeReservesFile();

        this.isRunning = false;

        //通知
        this.ipc.notifIo();

        // conflict を表示
        this.showConflict();

        this.log.system.info('updateAll done');
    }

    /**
    * 指定した rule の予約を更新
    */
    public async updateRule(ruleId: number): Promise<void> {
        if(this.isRunning) { throw new Error(ReservationManager.ReservationManagerIsRunningError); }
        this.isRunning = true;

        const finalize = () => { this.isRunning = false; }

        this.log.system.info(`start update rule: ${ ruleId }`);

        // rule を取得
        let rule: DBSchema.RulesSchema | null = null;
        try {
            let result = await this.rulesDB.findId(ruleId);
            if(result.length !== 0 && result[0].enable) {
                rule = result[0];
            }
        } catch(err) {
            finalize();
            throw err;
        }

        // 番組情報を取得
        let programs: DBSchema.ProgramSchema[] = []
        if(rule !== null) {;
            try {
                programs = await this.programDB.findRule(this.createSearchOption(rule));
            } catch(err) {
                finalize();
                throw err;
            }
        }

        // スキップ情報
        let skipIndex: { [key: number]: boolean } = {};
        // ruleId を除外した予約情報を生成
        let matches: ReserveProgram[] = [];
        for(let reserve of this.reserves) {
            //スキップ情報を記録
            if(reserve.isSkip) { skipIndex[reserve.program.id] = reserve.isSkip; }

            if(typeof reserve.ruleId === 'undefined' || reserve.ruleId !== ruleId) {
                let r: any = {};
                Object.assign(r, reserve);
                r.isConflict = false;
                matches.push(r);
            }
        }

        if(rule !== null) {
            // ruleId の番組情報を追加
            const ruleOption = this.createOption(rule);
            const encodeOption = this.createEncodeOption(rule);
            for(let program of programs) {
                let data: ReserveProgram = {
                    program: program,
                    ruleId: ruleId,
                    ruleOption: ruleOption,
                    isSkip: typeof skipIndex[program.id] === 'undefined' ? false : skipIndex[program.id],
                    isManual: false,
                    isConflict: false,
                };
                if(encodeOption !== null) {
                    data.encodeOption = encodeOption;
                }
                matches.push(data);
            }
        }

        // 予約情報を生成
        this.reserves = this.createReserves(matches);

        this.writeReservesFile();

        finalize();

        // conflict を表示
        this.showConflict();

        //通知
        this.ipc.notifIo();

        this.log.system.info(`done update rule: ${ ruleId }`);
    }

    /**
    * RulesSchema から searchInterface を生成する
    * @param rule: DBSchema.RulesSchema
    * @return SearchInterface
    */
    private createSearchOption(rule: DBSchema.RulesSchema): SearchInterface {
        let search: SearchInterface = {
            week: rule.week
        }

        if(rule.keyword !== null)       { search.keyword       = rule.keyword       }
        if(rule.ignoreKeyword !== null) { search.ignoreKeyword = rule.ignoreKeyword }
        if(rule.keyCS !== null)         { search.keyCS         = rule.keyCS         }
        if(rule.keyRegExp !== null)     { search.keyRegExp     = rule.keyRegExp     }
        if(rule.title !== null)         { search.title         = rule.title         }
        if(rule.description !== null)   { search.description   = rule.description   }
        if(rule.extended !== null)      { search.extended      = rule.extended      }
        if(rule.GR !== null)            { search.GR            = rule.GR            }
        if(rule.BS !== null)            { search.BS            = rule.BS            }
        if(rule.CS !== null)            { search.CS            = rule.CS            }
        if(rule.SKY !== null)           { search.SKY           = rule.SKY           }
        if(rule.station !== null)       { search.station       = rule.station       }
        if(rule.genrelv1 !== null)      { search.genrelv1      = rule.genrelv1      }
        if(rule.genrelv2 !== null)      { search.genrelv2      = rule.genrelv2      }
        if(rule.startTime !== null)     { search.startTime     = rule.startTime     }
        if(rule.timeRange !== null)     { search.timeRange     = rule.timeRange     }
        if(rule.isFree !== null)        { search.isFree        = rule.isFree        }
        if(rule.durationMin !== null)   { search.durationMin   = rule.durationMin   }
        if(rule.durationMax !== null)   { search.durationMax   = rule.durationMax   }

        return search;
    }

    /**
    * RulesSchema から OptionInterface を生成する
    * @param rule: DBSchema.RulesSchema
    * @return OptionInterface
    */
    private createOption(rule: DBSchema.RulesSchema): OptionInterface {
        let option: OptionInterface = {
            enable: rule.enable
        };

        if(rule.directory !== null) { option.directory = rule.directory; }
        if(rule.recordedFormat !== null) { option.recordedFormat = rule.recordedFormat; }

        return option;
    }

    /**
    * RulesSchema から EncodeInterface を生成する
    * @param rule: DBSchema.RulesSchema
    * @return OptionInterface | null
    */
    public createEncodeOption(rule: DBSchema.RulesSchema): EncodeInterface | null {
        if(rule.delTs === null) { return null; }

        let encode: EncodeInterface = {
            delTs: rule.delTs
        }

        if(rule.mode1 !== null) { encode.mode1 = rule.mode1; }
        if(rule.directory1 !== null) { encode.directory1 = rule.directory1; }
        if(rule.mode2 !== null) { encode.mode2 = rule.mode2; }
        if(rule.directory2 !== null) { encode.directory2 = rule.directory2; }
        if(rule.mode3 !== null) { encode.mode3 = rule.mode3; }
        if(rule.directory3 !== null) { encode.directory3 = rule.directory3; }

        return encode;
    }

    /**
    * 予約情報を生成する
    * @param matches 予約したい番組情報
    * @return ReserveProgram[] 予約情報
    */
    private createReserves(matches: ReserveProgram[]): ReserveProgram[] {
        //重複チェックのために programId でソート
        matches.sort(this.sortReserveProgram);

        let list: {
            time: apid.UnixtimeMS,
            isStart: boolean,
            idx: number, // matches index
        }[] = [];

        // 重複チェック用 index
        let programIndex: { [key: number]: boolean } = {};

        // list を生成
        for(let i = 0; i < matches.length; i++) {
            // programId がすでに存在する場合は list に追加しない
            if(typeof programIndex[matches[i].program.id] === 'undefined') {
                programIndex[matches[i].program.id] = true;
            } else {
                continue;
            }

            list.push({
                time: matches[i].program.startAt,
                isStart: true,
                idx: i,
            });
            list.push({
                time: matches[i].program.endAt,
                isStart: false,
                idx: i,
            });
        }

        // list を time でソート
        list.sort((a, b) => { return a.time - b.time });

        // 予約情報が格納可能かチェックする
        let reserves: { reserve: ReserveProgram, idx: number }[] = [];
        for(let l of list) {
            if(matches[l.idx].isSkip) { continue; }

            if(l.isStart) {
                // add
                reserves.push({ reserve: matches[l.idx], idx: l.idx });
            } else {
                // remove
                reserves = reserves.filter((r) => {
                    return r.idx !== l.idx;
                });
            }

            // sort reserves
            reserves.sort((a, b) => {
                return this.sortReserveProgram(a.reserve, b.reserve);
            });

            this.log.system.debug('--------------------');
            for(let r of reserves) {
                this.log.system.debug(<any>{
                    name: r.reserve.program.name,
                    ruleId: r.reserve.ruleId!,
                });
            }

            // tuner clear
            for(let i = 0; i < this.tuners.length; i++) {
                this.tuners[i].clear();
            }

            //重複の評価
            for(let reserve of reserves) {
                if(matches[reserve.idx].isSkip) { continue; }

                let isConflict = true;
                for(let i = 0; i < this.tuners.length; i++) {
                    try {
                        this.tuners[i].add(matches[reserve.idx].program);
                        isConflict = false;
                        break;
                    } catch(err) {
                        // tuner に追加できなかった
                    }
                }

                if(isConflict) {
                    matches[reserve.idx].isConflict = true;
                }
            }
        }

        // list から重複を除外した予約情報を生成
        let newReserves: ReserveProgram[] = [];
        for(let l of list) {
            if(l.isStart) { newReserves.push(matches[l.idx]); }
        }

        return newReserves.sort((a, b) => { return a.program.startAt - b.program.startAt });
    }

    /**
    * ReserveProgram のソート用関数
    * manualId が小さい > manualId が大きい > ruleId が小さい > ruleId が大きい の順で判定する
    * @param a: ReserveProgram
    * @param b: ReserveProgram
    * @return number
    */
    private sortReserveProgram(a: ReserveProgram, b: ReserveProgram): number {
        if(a.isManual && b.isManual) { return a.manualId! - b.manualId!; }
        if(a.isManual && !b.isManual) { return -1; }
        if(!a.isManual && b.isManual) { return 1; }
        if(!a.isManual && !b.isManual) { return a.ruleId! - b.ruleId!; }

        return 0;
    }

    /**
    * conflict を表示
    */
    private showConflict(): void {
        for(let reserve of this.reserves) {
            if(!reserve.isConflict) { continue; }
            this.log.system.warn(`conflict: ${ reserve.program.id } ${ DateUtil.format(new Date(reserve.program.startAt), 'yyyy-MM-ddThh:mm:ss') } ${ reserve.program.name }`);
        }
    }

    /**
    * 終了時刻を過ぎている予約を削除する
    */
    public clean(): void {
        let now = new Date().getTime();
        this.reserves = this.reserves.filter((reserve) => {
            return !(now > reserve.program.endAt);
        });
    }

    /**
    * 予約をファイルから読み込む
    */
    private readReservesFile(): void {
        try {
            let reserves = fs.readFileSync(this.reservesPath, "utf-8");
            this.reserves = JSON.parse(reserves);
        } catch(e) {
            if(e.code == 'ENOENT') {
                this.log.system.warn('reserves.json is not found.');
                this.reserves = [];
            } else {
                this.log.system.fatal(e);
                this.log.system.fatal('reserves.json parse error');
                process.exit();
            }
        }
    }

    /**
    * 予約をファイルへ書き込む
    */
    private writeReservesFile(): void {
        fs.writeFileSync(
            this.reservesPath,
            JSON.stringify(this.reserves),
            { encoding: 'utf-8' }
        );
    }
}

namespace ReservationManager {
    export const ReservationManagerIsRunningError = 'ReservationManagerIsRunning';
}

export { ReserveAllId, ReserveLimit, ReservationManagerInterface, ReservationManager };

