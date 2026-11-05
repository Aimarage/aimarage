UPDATE "workspaces" SET "limits" = ("limits" - 'braveCallsPerProjectDay') || jsonb_build_object('braveCallsPerDay', "limits"->'braveCallsPerProjectDay') WHERE "limits" ? 'braveCallsPerProjectDay';
