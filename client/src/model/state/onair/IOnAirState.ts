import * as apid from '../../../../../api';

export interface OnAirDisplayData {
    display: {
        channelName: string;
        time: string;
        name: string;
        description?: string;
        extended?: string;
    };
    schedule: apid.Schedule;
}

export default interface IOnAirState {
    selectedTab: apid.ChannelType | undefined;
    clearData(): void;
    fetchData(option: apid.BroadcastingScheduleOption): Promise<void>;
    getSchedules(type?: apid.ChannelType): OnAirDisplayData[];
    getTabs(): apid.ChannelType[];
}
