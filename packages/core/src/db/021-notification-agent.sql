-- Schema v21: remember which agent caused a notification, so Settings can mute
-- notifications from chosen agents without hiding their messages.

ALTER TABLE notifications ADD COLUMN agent TEXT;
