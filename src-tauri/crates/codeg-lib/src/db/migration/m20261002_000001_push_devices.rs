use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // push_device: the iPhones (and iPads) that receive codeg's
        // notifications through APNs. One row per APNs device token; a
        // re-registration of the same token updates the row and keeps its
        // prefs. Hard-deleted: removed from Settings, by the app itself, or
        // when Apple reports the token gone (410 Unregistered, BadDeviceToken).
        manager
            .create_table(
                Table::create()
                    .table(PushDevice::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PushDevice::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    // Hex APNs device token.
                    .col(ColumnDef::new(PushDevice::Token).text().not_null())
                    // "sandbox" (a development build) or "production"
                    // (TestFlight, App Store).
                    .col(
                        ColumnDef::new(PushDevice::Environment)
                            .text()
                            .not_null()
                            .default("production"),
                    )
                    // The app's bundle id: the `apns-topic` for this device.
                    .col(ColumnDef::new(PushDevice::BundleId).text().not_null())
                    .col(
                        ColumnDef::new(PushDevice::Name)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    .col(
                        ColumnDef::new(PushDevice::Platform)
                            .text()
                            .not_null()
                            .default("ios"),
                    )
                    // Per-device notification preferences (JSON, see
                    // `push::prefs::DevicePrefs`); unknown keys and a missing
                    // value read as the defaults.
                    .col(
                        ColumnDef::new(PushDevice::Prefs)
                            .text()
                            .not_null()
                            .default("{}"),
                    )
                    .col(
                        ColumnDef::new(PushDevice::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PushDevice::LastSeenAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_push_device_token")
                    .table(PushDevice::Table)
                    .col(PushDevice::Token)
                    .unique()
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(PushDevice::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum PushDevice {
    Table,
    Id,
    Token,
    Environment,
    BundleId,
    Name,
    Platform,
    Prefs,
    CreatedAt,
    LastSeenAt,
}
